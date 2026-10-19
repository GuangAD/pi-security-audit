/**
 * extensions/llm-wiring.test.ts — resolveLlmWiring / loadOverrides 机检
 *
 * 事实源:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/llm-wiring.ts」节
 * (pinned case 用例表、等价类矩阵 11 行、机检铁律 2 条、pi-ai Api 7 值枚举)。
 * 期望值全部为独立构造的字面量(智谱官方端点、pi 配置格式、spec 数据结构),
 * 不用被测代码的算法重算。
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveLlmWiring,
  loadOverrides,
  PROTOCOL_ENDPOINT_MAP,
  type LlmWiring,
  type LlmWiringError,
  type CsOverrideConfig,
  type SessionModelInfo,
} from "./llm-wiring.ts";

/** 密钥脱敏哨兵(AGENTS.md 密钥红线):任何输出面不得出现该串,仅 env 值允许 */
const KEY = "TESTKEY_SENTINEL_12345";

// —— 用例输入模型(事实源标注见 spec pinned case 表) ——

/** spec pinned 1:智谱 chat 协议(事实源:docs.bigmodel.cn Codex 专用 Responses 端点) */
const ZHIPU_CHAT: SessionModelInfo = {
  id: "glm-5.3-flash",
  provider: "zai-coding-cn",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  api: "openai-completions",
};

/** spec pinned 2:Responses 协议直连(事实源:pi models.json 实测配置) */
const DEEPSEEK_RESPONSES: SessionModelInfo = {
  id: "deepseek-chat",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  api: "openai-responses",
};

/** spec pinned 3:不兼容协议(事实源:cs 内嵌 Codex 0.162.1 仅支持 Responses 协议) */
const ANTHROPIC_MODEL: SessionModelInfo = {
  id: "claude-opus",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  api: "anthropic-messages",
};

// —— 测试环境:临时 agent-dir + 凭证环境变量受控 ——

let agentDir: string;
const savedEnv = new Map<string, string | undefined>();

function saveEnv(name: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
}
function restoreSavedEnvs(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

/** 清空三级凭证来源:auth.json / models.json 文件 + 凭证环境变量 */
function clearCredentials(): void {
  fs.rmSync(path.join(agentDir, "auth.json"), { force: true });
  fs.rmSync(path.join(agentDir, "models.json"), { force: true });
  for (const name of ["ZAI_API_KEY", "OVERRIDE_KEY"]) {
    saveEnv(name);
    delete process.env[name];
  }
}

/** 凭证一级来源:auth.json(结构事实源:pi 内部格式 { "<provider>": { type, key } }) */
function writeAuth(provider: string, key: string): void {
  fs.writeFileSync(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ [provider]: { type: "api_key", key } }),
    "utf8",
  );
}

/** 凭证二级来源:models.json 内联 apiKey(结构事实源:{ providers: { "<id>": { apiKey } } }) */
function writeModelsInline(provider: string, key: string): void {
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { [provider]: { name: provider, baseUrl: "", api: "", apiKey: key, models: [] } } }),
    "utf8",
  );
}

before(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wiring-test-"));
  saveEnv("PI_CODING_AGENT_DIR");
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
  restoreSavedEnvs();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearCredentials();
});

// —— 断言辅助 ——

function assertWiring(result: LlmWiring | LlmWiringError): asserts result is LlmWiring {
  assert.ok(
    !("reason" in result),
    `期望接线成功,实际返回错误:${JSON.stringify(result)}`,
  );
}

function assertWiringError(
  result: LlmWiring | LlmWiringError,
  reason: LlmWiringError["reason"],
): LlmWiringError {
  assert.ok("reason" in result, `期望错误 ${reason},实际接线成功:${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail.length > 0, "错误 detail 必须非空(补救指引)");
  return result;
}

/** 逆向解析一个 TOML basic string(独立于被测 tomlValue 的反方向实现) */
function parseTomlBasicString(raw: string): string {
  assert.ok(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2, `非 TOML basic string: ${raw}`);
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\") {
      const next = inner[i + 1];
      assert.ok(next === "\\" || next === '"', `未预期的 TOML 转义序列: \\${next}`);
      out += next;
      i++;
    } else {
      assert.notEqual(ch, '"', "basic string 内出现未转义双引号");
      out += ch;
    }
  }
  return out;
}

/** 逆向解析一个 --codex 'KEY=VALUE' 参数(机检铁律 2 的独立解析方向) */
function splitCodexArg(arg: string): [string, string] {
  const eq = arg.indexOf("=");
  assert.ok(eq > 0, `codexArg 不是 KEY=VALUE 形式: ${arg}`);
  return [arg.slice(0, eq), parseTomlBasicString(arg.slice(eq + 1))];
}

/** 独立构造的期望键值对(spec 后置条件:恰含 model_provider/name/base_url/wire_api/env_key 五类键 + web_search 禁用,共六键) */
function expectedCodexPairs(provider: string, baseUrl: string, envName: string): Map<string, string> {
  return new Map([
    ["model_provider", provider],
    [`model_providers.${provider}.name`, provider],
    [`model_providers.${provider}.base_url`, baseUrl],
    [`model_providers.${provider}.wire_api`, "responses"],
    [`model_providers.${provider}.env_key`, envName],
    ["web_search", "disabled"],
  ]);
}

/** codexArgs 经逆向 TOML 解析后须与期望键值对逐项相等(条数也相等,即"恰含") */
function assertCodexArgsMatch(wiring: LlmWiring, expected: Map<string, string>): void {
  assert.equal(wiring.codexArgs.length, expected.size, `codexArgs 条数须恰为 ${expected.size}:${JSON.stringify(wiring.codexArgs)}`);
  const actual = new Map(wiring.codexArgs.map(splitCodexArg));
  for (const [key, value] of expected) {
    assert.equal(actual.get(key), value, `codexArg 键 ${key} 期望值 ${value},实际 ${actual.get(key)}`);
  }
}

function codexArgValue(wiring: LlmWiring, key: string): string | undefined {
  return wiring.codexArgs.map(splitCodexArg).find(([k]) => k === key)?.[1];
}

// —— pinned case + 矩阵行 ——

test("pinned 1 / 矩阵行2:智谱 chat 协议经映射表转 Responses 端点(凭证 auth.json)", () => {
  writeAuth(ZHIPU_CHAT.provider, KEY);
  const result = resolveLlmWiring(ZHIPU_CHAT, null);
  assertWiring(result);
  assert.equal(result.model, "glm-5.3-flash"); // model 原样透传
  assert.equal(result.source, "session");
  assertCodexArgsMatch(result, expectedCodexPairs(
    "zai-coding-cn",
    "https://open.bigmodel.cn/api/v1", // 独立字面量:智谱官方文档 Codex 专用 Responses 端点
    "ZAI_API_KEY",
  ));
  assert.deepEqual(result.env, { ZAI_API_KEY: KEY }); // env 恰含一个键,值为明文 key
});

test("pinned 2 / 矩阵行1:Responses 协议直连,映射表不参与(凭证 auth.json)", () => {
  writeAuth(DEEPSEEK_RESPONSES.provider, KEY);
  const result = resolveLlmWiring(DEEPSEEK_RESPONSES, null);
  assertWiring(result);
  assert.equal(result.source, "session");
  assertCodexArgsMatch(result, expectedCodexPairs(
    "deepseek",
    "https://api.deepseek.com", // base_url 等于模型自身 baseUrl(独立字面量)
    "ZAI_API_KEY",
  ));
  // 强断言「映射表未参与」:即使 baseUrl 主机名命中映射表键,Responses 协议仍原样直连
  const mappedHostResponses: SessionModelInfo = {
    id: "glm-coding-responses",
    provider: "zai-coding-cn",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-responses",
  };
  writeAuth(mappedHostResponses.provider, KEY);
  const direct = resolveLlmWiring(mappedHostResponses, null);
  assertWiring(direct);
  assert.equal(codexArgValue(direct, "model_providers.zai-coding-cn.base_url"), "https://open.bigmodel.cn/api/coding/paas/v4");
});

test("pinned 3 / 矩阵行4:anthropic-messages 协议不兼容显式报错,无覆盖配置", () => {
  writeAuth(ANTHROPIC_MODEL.provider, KEY); // 任意凭证:协议报错不被凭证救回
  const result = resolveLlmWiring(ANTHROPIC_MODEL, null);
  const err = assertWiringError(result, "protocol-unsupported");
  assert.equal(err.provider, ANTHROPIC_MODEL.provider);
  assert.ok(err.detail.includes("anthropic"), `detail 须含 provider 名,实际:${err.detail}`);
});

test("矩阵行3:chat 协议无映射条目报 protocol-unsupported(任意凭证 + 会话)", () => {
  const unmappedChat: SessionModelInfo = {
    id: "acme-chat",
    provider: "acme-llm",
    baseUrl: "https://llm.example.com/v1/chat/completions",
    api: "openai-completions",
  };
  writeAuth(unmappedChat.provider, KEY);
  const result = resolveLlmWiring(unmappedChat, null);
  const err = assertWiringError(result, "protocol-unsupported");
  assert.equal(err.provider, unmappedChat.provider);
  assert.ok(err.detail.includes("acme-llm"), `detail 须含 provider 名,实际:${err.detail}`);
});

test("矩阵行10:无会话模型且无覆盖配置 → 错误(缺因:无模型 → protocol-unsupported),不抛", () => {
  const result = resolveLlmWiring(null, null);
  const err = assertWiringError(result, "protocol-unsupported");
  assert.ok(err.detail.length > 0, "错误 detail 须含补救指引");
});

test("pinned 4 / 矩阵行7:三级凭证来源皆空 → no-credential,detail 含补救指引", () => {
  // clearCredentials 已清空 auth.json / models.json / ZAI_API_KEY
  const result = resolveLlmWiring(DEEPSEEK_RESPONSES, null);
  const err = assertWiringError(result, "no-credential");
  assert.equal(err.provider, DEEPSEEK_RESPONSES.provider);
  assert.ok(err.detail.length > 0, "no-credential detail 须含补救指引");
});

test("矩阵行5:auth.json 缺、models.json 内联 apiKey 可得(凭证链二级)", () => {
  writeModelsInline(DEEPSEEK_RESPONSES.provider, KEY);
  const result = resolveLlmWiring(DEEPSEEK_RESPONSES, null);
  assertWiring(result);
  assert.equal(result.source, "session");
  assertCodexArgsMatch(result, expectedCodexPairs("deepseek", "https://api.deepseek.com", "ZAI_API_KEY"));
  assert.deepEqual(result.env, { ZAI_API_KEY: KEY });
});

test("矩阵行6:auth.json/models.json 皆缺、环境变量可得(凭证链三级)", () => {
  saveEnv("ZAI_API_KEY");
  process.env.ZAI_API_KEY = KEY;
  const result = resolveLlmWiring(DEEPSEEK_RESPONSES, null);
  assertWiring(result);
  assert.equal(result.source, "session");
  assert.deepEqual(result.env, { ZAI_API_KEY: KEY });
});

const OVERRIDES: CsOverrideConfig = {
  baseUrl: "https://override.example.com/api/v1",
  model: "override-model-9",
  apiKeyEnv: "OVERRIDE_KEY",
  providerName: "PI_OVERRIDE",
};

test("pinned 5 / 矩阵行8:会话模型可用(命中映射)时忽略覆盖配置,source=session", () => {
  writeAuth(ZHIPU_CHAT.provider, KEY);
  const result = resolveLlmWiring(ZHIPU_CHAT, OVERRIDES);
  assertWiring(result);
  assert.equal(result.source, "session");
  assert.equal(result.model, "glm-5.3-flash"); // 不被 overrides.model 污染
  assertCodexArgsMatch(result, expectedCodexPairs(
    "zai-coding-cn",
    "https://open.bigmodel.cn/api/v1",
    "ZAI_API_KEY",
  ));
});

test("pinned 6 / 矩阵行9:会话模型协议不兼容时启用覆盖配置,source=config", () => {
  saveEnv("OVERRIDE_KEY");
  process.env.OVERRIDE_KEY = KEY;
  const result = resolveLlmWiring(ANTHROPIC_MODEL, OVERRIDES);
  assertWiring(result);
  assert.equal(result.source, "config");
  assert.equal(result.model, "override-model-9");
  // base_url=overrides.baseUrl,provider 名与凭证环境变量名均取自 overrides
  assertCodexArgsMatch(result, expectedCodexPairs(
    "PI_OVERRIDE",
    "https://override.example.com/api/v1",
    "OVERRIDE_KEY",
  ));
  assert.deepEqual(result.env, { OVERRIDE_KEY: KEY });
});

test("矩阵行9补充:无会话模型(null)+ 覆盖配置 → source=config", () => {
  saveEnv("OVERRIDE_KEY");
  process.env.OVERRIDE_KEY = KEY;
  const result = resolveLlmWiring(null, OVERRIDES);
  assertWiring(result);
  assert.equal(result.source, "config");
  assert.equal(result.model, "override-model-9");
});

test("矩阵行9补充:覆盖配置 apiKeyEnv/providerName 缺省 → 默认 ZAI_API_KEY / PI_OVERRIDE", () => {
  saveEnv("ZAI_API_KEY");
  process.env.ZAI_API_KEY = KEY;
  const minimalOverrides: CsOverrideConfig = {
    baseUrl: "https://override.example.com/api/v1",
    model: "override-model-9",
  };
  const result = resolveLlmWiring(ANTHROPIC_MODEL, minimalOverrides);
  assertWiring(result);
  assert.equal(result.source, "config");
  assertCodexArgsMatch(result, expectedCodexPairs(
    "PI_OVERRIDE",
    "https://override.example.com/api/v1",
    "ZAI_API_KEY",
  ));
});

test("矩阵行9补充:覆盖配置但凭证环境变量未设 → no-credential", () => {
  const result = resolveLlmWiring(ANTHROPIC_MODEL, OVERRIDES);
  const err = assertWiringError(result, "no-credential");
  assert.ok(err.detail.length > 0, "no-credential detail 须含补救指引");
});

test("pinned 7:key 明文哨兵仅出现在 env,codexArgs 与 model 均不含(密钥红线)", () => {
  writeAuth(ZHIPU_CHAT.provider, KEY);
  const result = resolveLlmWiring(ZHIPU_CHAT, null);
  assertWiring(result);
  assert.equal(result.env["ZAI_API_KEY"], KEY);
  assert.ok(result.model.length > 0 && !result.model.includes(KEY), "model 不得含 key");
  for (const arg of result.codexArgs) {
    assert.ok(!arg.includes(KEY), `codexArg 泄漏 key: ${arg}`);
  }
});

test("矩阵行11边界声明:modelOverride 归 scan 工具层,不在 resolveLlmWiring 签名内(spec 签名 (sessionModel, overrides))", () => {
  assert.equal(resolveLlmWiring.length, 2, "resolveLlmWiring 只接受 (sessionModel, overrides) 两个参数");
  // 本函数 model 字段 = 会话模型 id 原样透传;替换逻辑由调用方(工具层)在返回值上执行
  writeAuth(DEEPSEEK_RESPONSES.provider, KEY);
  const result = resolveLlmWiring(DEEPSEEK_RESPONSES, null);
  assertWiring(result);
  assert.equal(result.model, DEEPSEEK_RESPONSES.id);
});

// —— 覆盖声明机检 ——

test("枚举范围:pi-ai Api 7 值逐一输入,每个值恰好命中直连/映射/报错三类分支之一", () => {
  writeAuth("enum-provider", KEY);
  const cases: Array<{ api: string; baseUrl: string; branch: "direct" | "mapped" | "error" }> = [
    { api: "openai-responses", baseUrl: "https://api.deepseek.com", branch: "direct" },
    { api: "azure-openai-responses", baseUrl: "https://myres.example.openai.azure.com", branch: "direct" },
    { api: "openai-codex-responses", baseUrl: "https://codex.example.com", branch: "direct" },
    { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", branch: "mapped" },
    { api: "openai-completions", baseUrl: "https://llm.example.com/v1", branch: "error" },
    { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", branch: "error" },
    { api: "bedrock-converse-stream", baseUrl: "https://bedrock.us-east-1.amazonaws.com", branch: "error" },
    { api: "mistral-conversations", baseUrl: "https://api.mistral.ai", branch: "error" },
  ];
  for (const c of cases) {
    const model: SessionModelInfo = { id: "enum-model", provider: "enum-provider", baseUrl: c.baseUrl, api: c.api };
    const result = resolveLlmWiring(model, null);
    if (c.branch === "error") {
      assertWiringError(result, "protocol-unsupported");
      continue;
    }
    assertWiring(result);
    const baseUrl = codexArgValue(result, "model_providers.enum-provider.base_url");
    if (c.branch === "direct") {
      assert.equal(baseUrl, c.baseUrl, `api=${c.api} 应直连`);
    } else {
      assert.equal(
        baseUrl,
        "https://open.bigmodel.cn/api/v1", // 智谱 Codex 专用 Responses 端点(独立字面量)
        `api=${c.api} 应命中映射表`,
      );
      assert.notEqual(baseUrl, c.baseUrl);
    }
  }
});

test("机检铁律1:全矩阵成功/错误结果除 env 外序列化文本不含 key 哨兵串", () => {
  const results: Array<LlmWiring | LlmWiringError> = [];
  // 行1 responses+auth;行2 chat映射+auth;行5 models.json;行6 env
  writeAuth(ZHIPU_CHAT.provider, KEY);
  results.push(resolveLlmWiring(ZHIPU_CHAT, null));
  clearCredentials();
  writeAuth(DEEPSEEK_RESPONSES.provider, KEY);
  results.push(resolveLlmWiring(DEEPSEEK_RESPONSES, null));
  clearCredentials();
  writeModelsInline(DEEPSEEK_RESPONSES.provider, KEY);
  results.push(resolveLlmWiring(DEEPSEEK_RESPONSES, null));
  clearCredentials();
  saveEnv("ZAI_API_KEY");
  process.env.ZAI_API_KEY = KEY;
  results.push(resolveLlmWiring(DEEPSEEK_RESPONSES, null));
  delete process.env.ZAI_API_KEY;
  // 行3/4/7/10 错误结果;行8/9 config 结果
  results.push(resolveLlmWiring(ANTHROPIC_MODEL, null));
  clearCredentials();
  results.push(resolveLlmWiring(DEEPSEEK_RESPONSES, null));
  results.push(resolveLlmWiring(null, null));
  writeAuth(ZHIPU_CHAT.provider, KEY);
  results.push(resolveLlmWiring(ZHIPU_CHAT, OVERRIDES)); // 行8:覆盖配置在场但 source=session
  clearCredentials();
  saveEnv("OVERRIDE_KEY");
  process.env.OVERRIDE_KEY = KEY;
  results.push(resolveLlmWiring(ANTHROPIC_MODEL, OVERRIDES)); // 行9
  delete process.env.OVERRIDE_KEY;

  for (const result of results) {
    const clone = { ...result };
    delete (clone as Partial<LlmWiring>).env; // 铁律范围:除 env 外全部序列化文本
    assert.ok(
      !JSON.stringify(clone).includes(KEY),
      `密钥哨兵泄漏于非 env 字段:${JSON.stringify(clone)}`,
    );
  }
});

test("机检铁律2:成功接线的 codexArgs 逐项经 TOML 逆解析还原键值对,键唯一且值非空", () => {
  writeAuth(ZHIPU_CHAT.provider, KEY);
  const wiring = resolveLlmWiring(ZHIPU_CHAT, null);
  assertWiring(wiring);
  const pairs = wiring.codexArgs.map(splitCodexArg);
  const keys = pairs.map(([k]) => k);
  assert.equal(new Set(keys).size, keys.length, "codexArgs 键不得重复");
  for (const [, value] of pairs) {
    assert.ok(value.length > 0, "TOML 逆解析值不得为空串键值对");
  }
  // 逆解析结果与独立构造的字面量全量相等(可逆解析的完备性)
  assert.deepEqual(
    new Map(pairs),
    expectedCodexPairs("zai-coding-cn", "https://open.bigmodel.cn/api/v1", "ZAI_API_KEY"),
  );
});

test("映射表消费:主机名精确匹配,不做后缀/子域猜测", () => {
  assert.equal(
    PROTOCOL_ENDPOINT_MAP["open.bigmodel.cn"],
    "https://open.bigmodel.cn/api/v1",
  );
  assert.equal(PROTOCOL_ENDPOINT_MAP["api.open.bigmodel.cn"], undefined, "子域不得被后缀匹配命中");
  // 后缀猜测反例:chat 协议 + 子域主机名 → 报错而非映射
  writeAuth("zai-sub", KEY);
  const subdomain: SessionModelInfo = {
    id: "glm-sub",
    provider: "zai-sub",
    baseUrl: "https://api.open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
  };
  const result = resolveLlmWiring(subdomain, null);
  assertWiringError(result, "protocol-unsupported");
});

// —— loadOverrides ——

test("loadOverrides 缺文件 → null 不抛(显式路径)", () => {
  const missing = path.join(agentDir, "no-such-file.json");
  assert.equal(loadOverrides(missing), null);
});

test("loadOverrides 合法完整配置 → 对象返回,字段值原样", () => {
  const file = path.join(agentDir, "full.json");
  fs.writeFileSync(file, JSON.stringify({
    baseUrl: "https://cfg.example.com/api/v1",
    model: "cfg-model-1",
    apiKeyEnv: "CFG_KEY",
    providerName: "CFG_PROVIDER",
  }), "utf8");
  assert.deepEqual(loadOverrides(file), {
    baseUrl: "https://cfg.example.com/api/v1",
    model: "cfg-model-1",
    apiKeyEnv: "CFG_KEY",
    providerName: "CFG_PROVIDER",
  });
});

test("loadOverrides 非法 JSON → null 不抛", () => {
  const file = path.join(agentDir, "broken.json");
  fs.writeFileSync(file, "{{{", "utf8");
  assert.equal(loadOverrides(file), null);
});

test("loadOverrides 缺必填字段(仅 {model}) → null", () => {
  const file = path.join(agentDir, "incomplete.json");
  fs.writeFileSync(file, JSON.stringify({ model: "cfg-model-1" }), "utf8");
  assert.equal(loadOverrides(file), null);
});

test("loadOverrides path 缺省 → 读 <agent-dir>/codex-security.json(经 PI_CODING_AGENT_DIR 解析)", () => {
  fs.writeFileSync(
    path.join(agentDir, "codex-security.json"),
    JSON.stringify({ baseUrl: "https://cfg.example.com/api/v1", model: "cfg-model-1" }),
    "utf8",
  );
  assert.deepEqual(loadOverrides(), {
    baseUrl: "https://cfg.example.com/api/v1",
    model: "cfg-model-1",
  });
});

test("loadOverrides 机检补充:随机字符串/空文件/超大文件/类型错位均不抛", () => {
  const dir = path.join(agentDir, "garbage");
  fs.mkdirSync(dir, { recursive: true });
  const randomFile = path.join(dir, "random.json");
  fs.writeFileSync(randomFile, "not-json-\u0000-\uffff garbage", "utf8");
  assert.equal(loadOverrides(randomFile), null);
  const emptyFile = path.join(dir, "empty.json");
  fs.writeFileSync(emptyFile, "", "utf8");
  assert.equal(loadOverrides(emptyFile), null);
  const hugeFile = path.join(dir, "huge.json");
  fs.writeFileSync(hugeFile, `"${"x".repeat(2 * 1024 * 1024)}"`, "utf8"); // 合法 JSON 字符串但非对象 → null
  assert.equal(loadOverrides(hugeFile), null);
  const wrongTypeFile = path.join(dir, "wrong-type.json");
  fs.writeFileSync(wrongTypeFile, JSON.stringify({ baseUrl: 123, model: ["a"] }), "utf8");
  assert.equal(loadOverrides(wrongTypeFile), null);
  // 目录路径(非文件)也不抛
  assert.equal(loadOverrides(dir), null);
});
