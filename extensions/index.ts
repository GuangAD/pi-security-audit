/**
 * extensions/index.ts — pi 装配层
 *
 * 契约:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/index.ts(pi 工具)」节。
 * 注册 codex_security_scan / codex_security_status / codex_security_run 三工具与
 * /security-scan 命令;session_shutdown 调 scan-runner.cleanup()(只清注册表与监听,不杀扫描进程)。
 *
 * 组合关系:接线(llm-wiring)→ 后台扫描(scan-runner)→ 状态与摘要(getScanStatus + findings-parser)→
 * 透传(run-executor)。本层只做参数装配、模型覆盖应用与错误映射:所有失败以 isError 结果返回,
 * 不向模型抛裸异常;错误文案用下游模块 detail/message 原文,不吞不改写。
 *
 * 密钥红线:wiring.env 只经 startScan 进入子进程环境变量;本层不落盘、不打印、不拼进命令行。
 */
import path from "node:path";

import { Type, type Static } from "typebox";

import { summarizeFindings } from "./findings-parser.ts";
import { loadOverrides, resolveLlmWiring } from "./llm-wiring.ts";
import { executeRun } from "./run-executor.ts";
import { activeScans, cleanup, getScanStatus, startScan, type ScanParams } from "./scan-runner.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// —— 本包实际使用的 pi 扩展面(结构性最小集;宿主类型 type-only 引入,运行时零依赖) ——

/** 文本内容块(pi 工具结果 content 的本包子集) */
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResult {
  content: TextBlock[];
  details: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** 结果文本提取(命令 handler 与测试共用) */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/** 工具定义(TypeBox schema + execute;execute 签名见 pi 扩展文档) */
interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

/** 命令定义(简写参数解析后等价于工具调用) */
interface CommandDef {
  description: string;
  handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

/** 命令上下文:仅消费 ui.notify */
interface CommandContext {
  ui: { notify: (message: string, options?: unknown) => void };
}

/** 工厂内部使用的 pi 方法面(宿主 ExtensionAPI 的结构性投影) */
interface PiSurface {
  registerTool(def: ToolDef): void;
  registerCommand(name: string, def: CommandDef): void;
  on(event: string, handler: () => void): void;
  getModel(): unknown;
  sendUserMessage(message: string): unknown;
}

/** isError 工具结果组装(错误文案原样透传,不吞不改写) */
function errorResult(content: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: content }], details: undefined };
}

// —— TypeBox schema(对齐 ScanParams 与 run/status 入参) ——

const scanSchema = Type.Object({
  scope: Type.Union([
    Type.Object({
      kind: Type.Literal("diff"),
      base: Type.String(),
      head: Type.Optional(Type.String()),
    }),
    Type.Object({
      kind: Type.Literal("workingTree"),
      base: Type.Optional(Type.String()),
    }),
    Type.Object({
      kind: Type.Literal("paths"),
      paths: Type.Array(Type.String(), { minItems: 1 }),
    }),
  ]),
  mode: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("deep")])),
  modelOverride: Type.Optional(Type.String()),
});
type ScanToolParams = Static<typeof scanSchema>;

const statusSchema = Type.Object({ scanDir: Type.String() });
type StatusToolParams = Static<typeof statusSchema>;

const runSchema = Type.Object({
  command: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  timeoutMs: Type.Optional(Type.Number()),
});
type RunToolParams = Static<typeof runSchema>;

/**
 * 扩展工厂:注册三工具 + /security-scan 命令 + session_shutdown 清理。
 * 无内部状态;scan 工具的完成通知与命令处理共用同一个内部执行函数。
 */
export default function (pi: ExtensionAPI): void {
  const api = pi as unknown as PiSurface;

  /** scan 工具内部执行(命令 handler 复用,不走 ctx.executeTool) */
  async function runScanTool(params: ScanParams): Promise<ToolResult> {
    // 会话模型跟随(ADR-0001):pi.getModel() 透传,协议/凭证解析在 llm-wiring
    const sessionModel = (api.getModel() ?? null) as Parameters<typeof resolveLlmWiring>[0];
    const wiring = resolveLlmWiring(sessionModel, loadOverrides());
    if ("reason" in wiring) {
      // detail 已含补救指引(/model 切换或写 <agent-dir>/codex-security.json),原文返回
      return errorResult(wiring.detail);
    }
    // 已登记 spec 变更:modelOverride 只换 model 字段,provider/端点/凭证解析不变(装配层应用)
    if (params.modelOverride !== undefined) wiring.model = params.modelOverride;

    let handle;
    try {
      handle = await startScan(params, wiring, process.cwd());
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    // 完成通知:进程退出(不论成败)后请模型查询并解读;依赖会话存活,重启后主动 status
    const entry = activeScans.get(handle.pid);
    if (entry) {
      entry.child.once("exit", () => {
        void api.sendUserMessage(
          `扫描进程已退出(pid ${handle.pid})。请调用 codex_security_status 查询 scanDir ${handle.scanDir} 的结果并向用户解读:以 report.md 为准,按严重级别只读汇报,不改代码。`,
        );
      });
    }

    const message = [
      `安全扫描已后台启动(pid ${handle.pid}),完成后会话内会收到通知。`,
      `scanDir: ${handle.scanDir}`,
      `命令行(脱敏): ${handle.command}`,
      `随时可用 codex_security_status(scanDir) 查询进度与摘要。`,
    ].join("\n");
    return {
      content: [{ type: "text", text: message }],
      details: { scanDir: handle.scanDir, pid: handle.pid },
      structuredContent: { ...handle },
    };
  }

  api.registerTool({
    name: "codex_security_scan",
    label: "Security Scan",
    description:
      "后台启动 codex-security 安全扫描:scope 三选一(diff 基线 / workingTree 工作树 / paths 路径),LLM 跟随会话模型,返回 scanDir 句柄。",
    parameters: scanSchema,
    execute: (_id, params, _signal, _onUpdate, _ctx) => runScanTool(params as ScanToolParams as ScanParams),
  });

  api.registerTool({
    name: "codex_security_status",
    label: "Security Scan Status",
    description:
      "凭 scanDir 查询扫描状态:running/completed/failed/unknown;completed 附 findings 严重级别摘要(解析失败降级 reportPath),不报假状态。",
    parameters: statusSchema,
    execute: async (_id, params, _signal, _onUpdate, _ctx): Promise<ToolResult> => {
      const { scanDir } = params as StatusToolParams;
      if (typeof scanDir !== "string" || !scanDir.trim() || !path.isAbsolute(scanDir)) {
        return errorResult(`scanDir 非法:必须是由 codex_security_scan 返回的产物目录绝对路径,收到:"${scanDir}"。`);
      }
      const status = await getScanStatus(scanDir);
      let structured: Record<string, unknown> = { ...status };
      let content: string;
      if (status.phase === "completed") {
        const summary = await summarizeFindings(scanDir);
        if ("degraded" in summary) {
          structured = { ...structured, degraded: true, reportPath: summary.reportPath };
          content = `扫描完成,但 findings 解析降级(不报假状态)。报告:${summary.reportPath ?? "未找到 report.md"}`;
        } else {
          structured = { ...structured, summary };
          const counts = summary.counts;
          content = [
            "扫描完成。",
            `严重级别:critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}`,
            `报告:${status.reportPath}`,
          ].join("\n");
        }
      } else {
        content = [
          `扫描状态:${status.phase}(pid ${status.pidAlive ? "存活" : "已退出"})。`,
          status.detail ?? "",
          status.logTail ? `日志尾部:\n${status.logTail}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      return { content: [{ type: "text", text: content }], details: { phase: status.phase }, structuredContent: structured };
    },
  });

  api.registerTool({
    name: "codex_security_run",
    label: "Security Scan Command",
    description:
      "白名单内原样透传执行 cs 子命令(前台,输出截断 50KB,退出码透传);login/logout/mcp 与未知命令拒绝。",
    parameters: runSchema,
    execute: async (_id, params, _signal, _onUpdate, _ctx): Promise<ToolResult> => {
      const { command, args, timeoutMs } = params as RunToolParams;
      const result = await executeRun(command, args ?? [], timeoutMs === undefined ? undefined : { timeoutMs });
      if ("rejected" in result) {
        return errorResult(`cs ${result.command} 已拒绝:${result.reason}`);
      }
      if ("timeout" in result) {
        return errorResult(
          `cs ${command} 超时(>${result.timeoutMs}ms),进程树已终止:可调大 timeoutMs 重试,或直接在终端执行。`,
        );
      }
      const message = `cs ${command} 退出码 ${result.exitCode}${result.truncated ? "(输出已截断)" : ""}:\n${result.output}`;
      return {
        content: [{ type: "text", text: message }],
        details: { exitCode: result.exitCode, truncated: result.truncated },
        structuredContent: { exitCode: result.exitCode, output: result.output, truncated: result.truncated },
      };
    },
  });

  api.registerCommand("security-scan", {
    description:
      "安全扫描当前分支相对基线的改动:无参默认 diff origin/main;working-tree 扫工作树;其余参数作为 diff base 透传。",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const params: ScanParams =
        trimmed === ""
          ? { scope: { kind: "diff", base: "origin/main" } }
          : trimmed === "working-tree"
            ? { scope: { kind: "workingTree" } }
            : { scope: { kind: "diff", base: trimmed } };
      const result = await runScanTool(params);
      const message = textOf(result);
      ctx.ui.notify(result.isError ? `安全扫描启动失败:${message}` : message);
    },
  });

  // session_shutdown 是事件(pi.on),非命令——官方示例扩展一致用法(auto-commit-on-exit.ts 等)
  api.on("session_shutdown", () => {
    cleanup();
  });
}
