/**
 * extensions/index.ts — pi-security-audit 装配层
 *
 * 注册薄工具(resolve_scan_model / validate_scan_artifacts——后者任务 3 加入)。
 * 设计原则(ADR-0004):代码只做「确定性计算」,方法论判断留给 agent 与 skills。
 * 所有失败以 isError 结果返回,不向模型抛裸异常;detail 文案原样透传。
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { pluginSchemaPath, validateAgainstSchema } from "./artifact-validator.ts";

import { resolveScanModel } from "./scan-model.ts";

/** 文本内容块(pi 工具结果 content 的本包子集) */
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResult {
  content: TextBlock[];
  details: unknown;
  isError?: boolean;
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

/** 工厂内部使用的 pi 方法面(宿主 ExtensionAPI 的结构性投影) */
interface PiSurface {
  registerTool(def: ToolDef): void;
}

const resolveModelSchema = Type.Object({});

const validateArtifactsSchema = Type.Object({
  kind: Type.Union([Type.Literal("findings"), Type.Literal("coverage")], {
    description: "产物类型:findings 或 coverage",
  }),
  path: Type.String({ description: "产物 JSON 文件的绝对或相对路径" }),
});

/** 注册薄工具(pi 插件入口,加载时被调用一次) */
export function registerSecurityAudit(pi: PiSurface): void {
  pi.registerTool({
    name: "resolve_scan_model",
    label: "解析扫描引擎模型",
    description:
      "解析安全审计的引擎模型(配置优先,回退会话模型;ADR-0003)。审计编排的派发前必调:ok 时用返回的 provider/model 派发 subagent;错误时向用户展示 detail 的补救指引,不得自行猜测模型。",
    parameters: resolveModelSchema,
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const model = (ctx as { model?: unknown } | undefined)?.model;
      const r = resolveScanModel(undefined, model as { provider?: string; id?: string } | null | undefined);
      const text = r.ok
        ? `引擎模型:${r.provider}/${r.model}(来源:${r.source === "config" ? "配置文件" : "会话模型"})`
        : `引擎模型解析失败:${r.detail}`;
      return { content: [{ type: "text", text }], details: r, isError: !r.ok };
    },
  });

  pi.registerTool({
    name: "validate_scan_artifacts",
    label: "校验扫描产物契约",
    description:
      "按契约校验扫描产物 JSON(findings/coverage 二选一)。进入报告前必调:ok:false 时把 errors 逐条回传给产物作者修复,不得带病出报告。",
    parameters: validateArtifactsSchema,
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const p = params as { kind: "findings" | "coverage"; path: string };
      // 自审 cand-02:kind 白名单不单点依赖宿主 TypeBox 校验
      if (p.kind !== "findings" && p.kind !== "coverage") {
        return { content: [{ type: "text", text: `kind 必须为 findings 或 coverage,实际 ${JSON.stringify((params as { kind?: unknown }).kind)}` }], details: undefined, isError: true };
      }
      let doc: unknown;
      try {
        doc = JSON.parse(fs.readFileSync(p.path, "utf8"));
      } catch (e) {
        return {
          content: [{ type: "text", text: `无法读取产物文件:${p.path}(文件缺失或不是合法 JSON;详情用只读工具查看)` }],
          details: undefined,
          isError: true,
        };
      }
      const schemaPath = pluginSchemaPath(`${p.kind}.schema.json`); // 自审 cand-11:复用显式失败路径,不回退 CWD
      const r = validateAgainstSchema(doc, schemaPath);
      const text = r.ok
        ? `${p.kind} 产物契约校验通过。`
        : `产物契约校验失败(${r.errors.length} 处):\n${r.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")}`;
      return { content: [{ type: "text", text }], details: r, isError: !r.ok };
    },
  });
}

export default function (pi: PiSurface): void {
  registerSecurityAudit(pi);
}
