/**
 * extensions/run-executor.ts — run 工具的可执行核心
 *
 * 契约:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/run-executor.ts」节
 * (白名单判定、前台执行、输出截断、超时杀树;独立于 pi ctx 以支持 node:test 直测)。
 *
 * cs 启动目标复用 scan-runner 的 resolveCsSpawnTarget(Windows .cmd 垫片解析,勿重写)。
 * 密钥红线:本模块不接触任何凭证;argv 原样透传,不落盘、不打日志。
 */
import { spawn, type ChildProcess } from "node:child_process";

import { buildChildEnv, resolveCsSpawnTarget } from "./scan-runner.ts";

// —— 白名单(cs --help 固化于 2026-10-16,24 个子命令) ——

/** cs 子命令全集(事实源:cs --help 固化清单) */
const ALL_CS_SUBCOMMANDS = [
  "scan",
  "policy",
  "validate",
  "patch",
  "verify-fix",
  "scans",
  "findings",
  "classify-severity",
  "dedupe",
  "suggest-owners",
  "export",
  "import",
  "publish",
  "bulk-scan",
  "scan-components",
  "install-hook",
  "login",
  "logout",
  "init",
  "info",
  "feedback",
  "completions",
  "mcp",
  "skills",
] as const;

/** 固定拒绝:login/logout 凭证走 pi 路线(终端执行);mcp 官方排除扫描走 MCP */
const REJECTED_CREDENTIAL = ["login", "logout"] as const;

/** 白名单只读常量:ALLOWED(放行集)与 REJECTED(拒绝集),两集不交、并集为全集 */
export const CS_SUBCOMMAND_WHITELIST = Object.freeze({
  ALLOWED: new Set<string>(ALL_CS_SUBCOMMANDS.filter((c) => !REJECTED_CREDENTIAL.includes(c as never) && c !== "mcp")),
  REJECTED: new Set<string>([...REJECTED_CREDENTIAL, "mcp"]),
});

/** 合法子命令清单文本(未知命令拒绝时附上) */
const ALLOWED_LIST_TEXT = [...CS_SUBCOMMAND_WHITELIST.ALLOWED].join(", ");

/** 白名单判定结果 */
export type CsCommandDecision = { allowed: true } | { allowed: false; kind: "credential" | "mcp" | "unknown" };

/** 唯一白名单判定函数:login/logout/mcp 固定拒绝,全集其余放行,白名单外按 unknown 拒绝 */
export function decideCsCommand(command: string): CsCommandDecision {
  if ((REJECTED_CREDENTIAL as readonly string[]).includes(command)) return { allowed: false, kind: "credential" };
  if (command === "mcp") return { allowed: false, kind: "mcp" };
  if (CS_SUBCOMMAND_WHITELIST.ALLOWED.has(command)) return { allowed: true };
  return { allowed: false, kind: "unknown" };
}

/** 拒绝文案(附指引;login/logout 指引终端执行,mcp 附官方排除说明,unknown 附合法清单) */
function rejectionReason(command: string, kind: "credential" | "mcp" | "unknown"): string {
  if (kind === "credential") {
    return `cs ${command} 是凭证命令,已拒绝经工具执行:请在终端执行 cs ${command} 完成登录/登出。pi 内扫描凭证由会话模型接线自动注入,无需登录。`;
  }
  if (kind === "mcp") {
    return "cs mcp 已拒绝:官方排除扫描走 MCP(MCP 传输无法取消活动命令,scan 仅 CLI)。扫描请用 codex_security_scan 工具。";
  }
  return `未知 cs 子命令 "${command}"。合法子命令清单:${ALLOWED_LIST_TEXT}。(login/logout/mcp 固定拒绝。)`;
}

// —— 数值预算(spec:默认 600s,参数上限 3600s;输出截断 50KB) ——

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
const OUTPUT_LIMIT_BYTES = 50 * 1024;
const TRUNCATION_MARKER = "…[截断]";

/**
 * 超时参数归一化:缺省/≤0/非数 → 默认 600_000;>3_600_000 → 3_600_000;其余原样。
 * 独立纯函数,便于对数值预算逐值机检。
 */
export function normalizeRunTimeoutMs(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

// —— executeRun 结果 ——

/** 白名单内前台执行成功(含非零退出码透传) */
export interface RunCompleted {
  exitCode: number;
  output: string;
  truncated: boolean;
}
/** 白名单拒绝(login/logout/mcp/未知) */
export interface RunRejected {
  rejected: true;
  command: string;
  reason: string;
}
/** 超时杀进程树 */
export interface RunTimeout {
  timeout: true;
  timeoutMs: number;
}

/** 杀进程树:Windows 用 taskkill /T /F(实测可用);POSIX 直接 SIGKILL 子进程 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    if (child.pid !== undefined) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
    return;
  }
  child.kill("SIGKILL");
}

/**
 * 白名单内命令前台执行:stdout+stderr 合并捕获,超 50KB 截断并附标记;
 * 超时(默认 600s,上限 3600s)杀进程树返回 RunTimeout;
 * login/logout/mcp 与未知命令一律 RunRejected,不 spawn。
 * 继承当前 cwd;无内部状态,重复调用独立。
 */
export async function executeRun(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<RunCompleted | RunRejected | RunTimeout> {
  const decision = decideCsCommand(command);
  if (!decision.allowed) {
    return { rejected: true, command, reason: rejectionReason(command, decision.kind) };
  }
  const timeoutMs = normalizeRunTimeoutMs(opts?.timeoutMs);

  const target = resolveCsSpawnTarget();
  // scan 命令补 --auth api-key:与 codex_security_scan 同源,避免真实扫描撞 cs auto 预检与 win32 credential-home ACL 拦截
  const scanAuthArgs = command === "scan" && !args.includes("--auth") ? ["--auth", "api-key"] : [];
  const child = spawn(target.command, [...target.prefixArgs, command, ...scanAuthArgs, ...args], {
    cwd: process.cwd(),
    env: buildChildEnv({}),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return await new Promise<RunCompleted | RunTimeout>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      if (truncated) return; // 已达上限:继续排水,不再累积
      const remaining = OUTPUT_LIMIT_BYTES - total;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = OUTPUT_LIMIT_BYTES;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    const finish = (result: RunCompleted | RunTimeout): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({ timeout: true, timeoutMs });
        return;
      }
      let output = Buffer.concat(chunks).toString("utf8");
      if (truncated) output += TRUNCATION_MARKER;
      finish({ exitCode: code ?? 1, output, truncated }); // code 为 null(信号终止)按失败退出码 1 呈现
    });
  });
}
