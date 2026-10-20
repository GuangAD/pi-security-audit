/** scan-model 引擎模型解析的契约测试(spec:resolveScanModel 用例详版 7 例 + 机检铁律) */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadScanConfig, resolveScanModel } from "./scan-model.ts";

/** 每用例独立临时目录(用完即弃) */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scan-model-test-"));
}

function writeConfig(dir: string, content: string): string {
  const p = path.join(dir, "security-audit.json");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const SESSION = { provider: "cc-switch-zhipu-glm", id: "glm-5.3-flash" };

test("用例 1 配置优先:合法配置 + 会话模型存在 → source=config", () => {
  const dir = tmpDir();
  const p = writeConfig(dir, JSON.stringify({ model: "zai/glm-5.3" }));
  const r = resolveScanModel(p, SESSION);
  assert.deepEqual(r, { ok: true, provider: "zai", model: "glm-5.3", source: "config" });
});

test("用例 2 会话回退:无配置文件 + 会话模型存在 → source=session", () => {
  const dir = tmpDir();
  const r = resolveScanModel(path.join(dir, "absent.json"), SESSION);
  assert.deepEqual(r, { ok: true, provider: SESSION.provider, model: SESSION.id, source: "session" });
});

test("用例 3 损坏 JSON 显式报错:不回退会话模型", () => {
  const dir = tmpDir();
  const p = writeConfig(dir, "{ not json !!!");
  const r = resolveScanModel(p, SESSION);
  assert.equal(r.ok, false, "损坏配置必须 ok:false");
  if (!r.ok) {
    assert.equal(r.reason, "config-corrupt");
    assert.match(r.detail, /损坏配置/, "人类可读文案在 detail");
    assert.ok(!("source" in r), "不得携带 source(未回退)");
  }
});

test("用例 4 缺 model 字段损坏:不回退", () => {
  const dir = tmpDir();
  const p = writeConfig(dir, "{}");
  const r = resolveScanModel(p, SESSION);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "config-corrupt");
    assert.match(r.detail, /model/);
  }
});

test("用例 5 model 缺 provider 前缀损坏:不回退", () => {
  const dir = tmpDir();
  const p = writeConfig(dir, JSON.stringify({ model: "glm-5.3-flash" }));
  const r = resolveScanModel(p, SESSION);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "config-corrupt");
    assert.match(r.detail, /provider-id\/model-id/);
  }
});

test("用例 6 双缺失报错:无配置 + 会话模型 undefined → detail 含补救指引", () => {
  const dir = tmpDir();
  const r = resolveScanModel(path.join(dir, "absent.json"), undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "no-model");
    assert.match(r.detail, /security-audit\.json/);
    assert.match(r.detail, /\/model/);
  }
});

test("用例 7 configPath 参数重定向:按指定文件解析", () => {
  const dir = tmpDir();
  const custom = path.join(dir, "custom.json");
  fs.writeFileSync(custom, JSON.stringify({ model: "other/model-x" }), "utf8");
  const r = resolveScanModel(custom, SESSION);
  assert.deepEqual(r, { ok: true, provider: "other", model: "model-x", source: "config" });
});

test("铁律:ok:true 时 source 与实际来源一致(合法配置永不为 session)", () => {
  const dir = tmpDir();
  const p = writeConfig(dir, JSON.stringify({ model: "zai/glm-5.3" }));
  const r = resolveScanModel(p, SESSION);
  assert.ok(r.ok && r.source === "config");
});

test("附:loadScanConfig 三态直测(absent/ok/corrupt)", () => {
  const dir = tmpDir();
  assert.deepEqual(loadScanConfig(path.join(dir, "nope.json")), { state: "absent" });
  const p = writeConfig(dir, JSON.stringify({ model: "a/b" }));
  assert.deepEqual(loadScanConfig(p), { state: "ok", config: { provider: "a", model: "b" } });
  assert.equal(loadScanConfig(p).state, "ok");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "[1,2]", "utf8");
  assert.equal(loadScanConfig(bad).state, "corrupt");
});

test('守卫 cand-04:不可读(目录/EISDIR 等非 ENOENT)→ corrupt,不静默回退', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const r = resolveScanModel(dir, SESSION); // 目录当文件读 → 非 ENOENT 错误
  assert.equal(r.ok, false, '非 ENOENT 读错误必须显式报错');
  if (!r.ok) assert.equal(r.reason, 'config-corrupt');
});
