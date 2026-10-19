/**
 * extensions/llm-wiring.ts — 会话模型 → cs 扫描引擎 LLM 接线
 *
 * 唯一知道 pi 配置文件格式(auth.json / models.json)与协议端点映射表的模块。
 * 契约:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/llm-wiring.ts」节。
 * 密钥红线(AGENTS.md):API key 只进入返回值 env(子进程环境变量链),
 * 禁止出现在 codexArgs、错误消息、任何落盘文本。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** pi 会话当前模型的最小形状(不 import pi 包类型,保持零耦合、可测) */
export interface SessionModelInfo {
  id: string;
  provider: string;
  baseUrl: string;
  api: string;
}

/** LLM 接线结果:传给 cs scan 的注入参数与子进程环境变量 */
export interface LlmWiring {
  /** 逐项对应一个 --codex 'KEY=VALUE' 参数,值已按 TOML 规则加引号转义 */
  codexArgs: string[];
  /** 注入扫描子进程的环境变量;key 值只出现在这里 */
  env: Record<string, string>;
  /** 透传给 cs --model 的模型 id */
  model: string;
  /** 接线来源:会话模型直连/映射,或覆盖配置文件 */
  source: "session" | "config";
}

/** LLM 接线失败:工具层转为 isError 结果,detail 不含任何密钥值 */
export interface LlmWiringError {
  reason: "protocol-unsupported" | "no-credential" | "cs-missing";
  provider?: string;
  detail: string;
}

/** 扫描专用覆盖配置 <agent-dir>/codex-security.json 的解析结果 */
export interface CsOverrideConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  providerName?: string;
}

/**
 * Chat Completions 端点 → OpenAI Responses 端点映射表。
 * 键 = baseUrl 主机名(精确匹配,不做后缀猜测);值 = 对应 Responses 端点完整 URL。
 * 事实源:智谱官方文档 docs.bigmodel.cn(Codex 专用 Responses 端点)。
 */
export const PROTOCOL_ENDPOINT_MAP: Readonly<Record<string, string>> = Object.freeze({
  "open.bigmodel.cn": "https://open.bigmodel.cn/api/v1",
});

/** 默认凭证环境变量名(CsOverrideConfig.apiKeyEnv 的缺省值;design.md 权衡节) */
const DEFAULT_API_KEY_ENV = "ZAI_API_KEY";

/** agent-dir 解析:PI_CODING_AGENT_DIR 环境变量 → ~/.pi/agent 回退;任何路径不得写死 */
function resolveAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".pi", "agent");
}

/** TOML 值构造:双引号包裹,内部反斜杠与双引号转义;全部 --codex 值一律经此函数 */
function tomlValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** web_search 禁用覆盖(cs --codex TOML 项):扫描主线程继承 Codex 默认会带 web_search 工具,第三方 Responses 网关不支持即拒;buildWiring 与 run-executor scan 注入共用 */
export const WEB_SEARCH_DISABLED_CODEX_ARG = `web_search=${tomlValue("disabled")}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读 JSON 文件;缺失/非法 JSON/非对象一律返回 null(读不到即降级,不抛) */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** 凭证一级来源:auth.json 中 provider 同名条目 { "<provider>": { "type": "api_key", "key": "<key>" } } */
function readAuthKey(provider: string): string | null {
  const data = readJsonFile(path.join(resolveAgentDir(), "auth.json"));
  if (!isRecord(data)) return null;
  const entry = data[provider];
  if (isRecord(entry) && typeof entry.key === "string" && entry.key) return entry.key;
  return null;
}

/** 凭证二级来源:models.json providers 里同名 provider 的内联 apiKey */
function readModelsInlineKey(provider: string): string | null {
  const data = readJsonFile(path.join(resolveAgentDir(), "models.json"));
  if (!isRecord(data) || !isRecord(data.providers)) return null;
  const entry = data.providers[provider];
  if (isRecord(entry) && typeof entry.apiKey === "string" && entry.apiKey) return entry.apiKey;
  return null;
}

/** 凭证三级解析(会话路径):auth.json → models.json 内联 apiKey → 环境变量 ZAI_API_KEY,读到即止 */
function resolveSessionCredential(provider: string): string | null {
  return (
    readAuthKey(provider) ??
    readModelsInlineKey(provider) ??
    (process.env[DEFAULT_API_KEY_ENV] || null)
  );
}

/** 会话协议 → cs 端点:api 含 "responses" 直连;openai-completions 查映射表;其余不支持 */
function resolveSessionEndpoint(model: SessionModelInfo): { ok: true; baseUrl: string } | { ok: false } {
  if (model.api.includes("responses")) return { ok: true, baseUrl: model.baseUrl };
  if (model.api === "openai-completions") {
    let host: string;
    try {
      host = new URL(model.baseUrl).hostname;
    } catch {
      return { ok: false };
    }
    const mapped = Object.hasOwn(PROTOCOL_ENDPOINT_MAP, host) ? PROTOCOL_ENDPOINT_MAP[host] : undefined;
    if (mapped) return { ok: true, baseUrl: mapped };
  }
  return { ok: false };
}

/** 组装五类键的 --codex 参数与单键 env(密钥只进 env) */
function buildWiring(opts: {
  providerName: string;
  baseUrl: string;
  model: string;
  envName: string;
  key: string;
  source: "session" | "config";
}): LlmWiring {
  const n = opts.providerName;
  return {
    codexArgs: [
      `model_provider=${tomlValue(n)}`,
      `model_providers.${n}.name=${tomlValue(n)}`,
      `model_providers.${n}.base_url=${tomlValue(opts.baseUrl)}`,
      `model_providers.${n}.wire_api=${tomlValue("responses")}`,
      `model_providers.${n}.env_key=${tomlValue(opts.envName)}`,
      // web_search 禁用:cs 扫描主线程不设该键,继承 Codex 默认会带 web_search 工具,
      // 第三方 Responses 网关(如 mimo)不支持即拒绝(preflight 失败);cs 自身四个辅助线程
      // 全部显式禁用(api.js validate/policy/dedup/remediation),官方端点上 disabled 亦合法。
      WEB_SEARCH_DISABLED_CODEX_ARG,
    ],
    env: { [opts.envName]: opts.key },
    model: opts.model,
    source: opts.source,
  };
}

/** 会话模型是否已提供(覆盖配置仅在会话不可用时启用;ADR-0001) */
function hasSessionModel(sessionModel: SessionModelInfo | null): sessionModel is SessionModelInfo {
  return sessionModel !== null;
}

/**
 * 把会话当前模型(或覆盖配置)解析为 cs 的 provider 注入。
 * 解析顺序(ADR-0001):会话模型可用(协议命中)→ 忽略覆盖配置;协议不兼容或无会话模型 → 覆盖配置;皆无 → 显式报错。
 * 错误一律以返回值上报,不抛异常,永不静默换 provider。
 */
export function resolveLlmWiring(
  sessionModel: SessionModelInfo | null,
  overrides: CsOverrideConfig | null,
): LlmWiring | LlmWiringError {
  if (hasSessionModel(sessionModel)) {
    const endpoint = resolveSessionEndpoint(sessionModel);
    if (endpoint.ok) {
      const key = resolveSessionCredential(sessionModel.provider);
      if (!key) {
        return {
          reason: "no-credential",
          provider: sessionModel.provider,
          detail: `未找到 provider "${sessionModel.provider}" 的 API key:请在 pi 登录该 provider(auth.json),或在 models.json 为其配置内联 apiKey,或设置环境变量 ${DEFAULT_API_KEY_ENV}。`,
        };
      }
      return buildWiring({
        providerName: sessionModel.provider,
        baseUrl: endpoint.baseUrl,
        model: sessionModel.id,
        envName: DEFAULT_API_KEY_ENV,
        key,
        source: "session",
      });
    }
  }

  // 会话不可用(无模型或协议不兼容)→ 启用覆盖配置(ADR-0001 三级解析第二级)
  if (overrides) {
    const envName = overrides.apiKeyEnv || DEFAULT_API_KEY_ENV;
    const key = process.env[envName] || null;
    if (!key) {
      return {
        reason: "no-credential",
        detail: `覆盖配置指定的凭证环境变量 ${envName} 未设置:请设置该环境变量(API key 不写入命令行与配置文件)。`,
      };
    }
    return buildWiring({
      providerName: overrides.providerName || "PI_OVERRIDE",
      baseUrl: overrides.baseUrl,
      model: overrides.model,
      envName,
      key,
      source: "config",
    });
  }

  return {
    reason: "protocol-unsupported",
    provider: sessionModel?.provider,
    detail: sessionModel
      ? `会话模型 provider "${sessionModel.provider}"(api=${sessionModel.api})的协议不被 cs 扫描引擎接受:仅支持 Responses 协议,Chat 协议仅映射表内智谱系端点可用。请用 /model 切换模型,或创建 <agent-dir>/codex-security.json 覆盖配置。`
      : `未获得会话模型(pi.getModel() 为空)且无覆盖配置,无法接线。请用 /model 切换模型,或创建 <agent-dir>/codex-security.json 覆盖配置。`,
  };
}

/**
 * 读扫描专用覆盖配置。path 缺省时读 <agent-dir>/codex-security.json(agent-dir 经 resolveAgentDir 解析)。
 * 只读文件系统;缺文件 / 非法 JSON / 缺必填字段 → null(容忍,不抛)。
 */
export function loadOverrides(filePath?: string): CsOverrideConfig | null {
  const target = filePath ?? path.join(resolveAgentDir(), "codex-security.json");
  const data = readJsonFile(target);
  if (!isRecord(data)) return null;
  const { baseUrl, model, apiKeyEnv, providerName } = data;
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  if (typeof model !== "string" || !model) return null;
  const result: CsOverrideConfig = { baseUrl, model };
  if (typeof apiKeyEnv === "string" && apiKeyEnv) result.apiKeyEnv = apiKeyEnv;
  if (typeof providerName === "string" && providerName) result.providerName = providerName;
  return result;
}
