/**
 * 引擎模型解析:配置优先 → 会话模型回退 → 显式报错(ADR-0003)。
 * 数据来源:<agent-dir>/security-audit.json(缺省)或 configPath 注入(测试)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 引擎配置(security-audit.json)的解析产物 */
export interface ScanConfig {
  provider: string;
  model: string;
}

/** loadScanConfig 的三种状态:缺失 / 合法 / 损坏(损坏必须显式暴露,不静默降级) */
export type LoadScanConfigResult =
  | { state: "absent" }
  | { state: "ok"; config: ScanConfig }
  | { state: "corrupt"; reason: string };

/** resolveScanModel 的返回:ok 带来源标注,或显式报错(含补救指引) */
export type ScanModelResult =
  | { ok: true; provider: string; model: string; source: "config" | "session" }
  | { ok: false; reason: string; detail: string };

/** 会话模型的形状投影(pi 的 ctx.model,只取本函数关心的字段) */
export interface SessionModelShape {
  provider?: string;
  id?: string;
}

/** agent-dir 解析:PI_CODING_AGENT_DIR 环境变量 → ~/.pi/agent 回退;任何路径不得写死 */
export function resolveAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".pi", "agent");
}

/** 缺省配置路径:<agent-dir>/security-audit.json */
export function defaultConfigPath(): string {
  return path.join(resolveAgentDir(), "security-audit.json");
}

/**
 * 读引擎配置文件。
 * 缺文件 → absent;非法 JSON / 缺 model / model 缺 provider 前缀 → corrupt(附原因);否则 ok。
 * 纯读,不抛(损坏是返回值语义,不是异常)。
 */
export function loadScanConfig(configPath?: string): LoadScanConfigResult {
  const target = configPath ?? defaultConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    // 自审 cand-04:非 ENOENT(权限/目录等)必须显式暴露,不静默回退会话模型(ADR-0003)
    return { state: "corrupt", reason: `损坏配置:security-audit.json 不可读(${(e as NodeJS.ErrnoException).code ?? "未知错误"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "corrupt", reason: "损坏配置:security-audit.json 不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "corrupt", reason: "损坏配置:security-audit.json 顶层必须是对象" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    return { state: "corrupt", reason: "损坏配置:security-audit.json 缺少 model 字段(格式 provider-id/model-id)" };
  }
  const slash = obj.model.indexOf("/");
  if (slash <= 0 || slash === obj.model.length - 1) {
    return { state: "corrupt", reason: `损坏配置:model 必须为 provider-id/model-id 形式,实际 "${obj.model}"` };
  }
  return {
    state: "ok",
    config: { provider: obj.model.slice(0, slash), model: obj.model.slice(slash + 1) },
  };
}

/**
 * 解析扫描引擎模型:配置优先 → 会话回退 → 显式报错(ADR-0003)。
 * 损坏配置不回退会话模型(坏配置必须被看见)。
 */
export function resolveScanModel(
  configPath: string | undefined,
  sessionModel?: SessionModelShape | null,
): ScanModelResult {
  const loaded = loadScanConfig(configPath);
  if (loaded.state === "ok") {
    return { ok: true, ...loaded.config, source: "config" };
  }
  if (loaded.state === "corrupt") {
    return {
      ok: false,
      reason: "config-corrupt",
      detail: `${loaded.reason};请修复该文件或删除它以回退会话模型(ADR-0003:损坏配置不静默降级)`,
    };
  }
  const provider = typeof sessionModel?.provider === "string" ? sessionModel.provider : undefined;
  const id = typeof sessionModel?.id === "string" ? sessionModel.id : undefined;
  if (provider && id) {
    return { ok: true, provider, model: id, source: "session" };
  }
  return {
    ok: false,
    reason: "no-model",
    detail:
      "未获得引擎模型:无 security-audit.json 配置,且当前会话无模型。请在 <agent-dir>/security-audit.json 写入 {\"model\": \"provider-id/model-id\"},或用 /model 选择会话模型。",
  };
}
