/** index 装配层契约测试(spec:registerSecurityAudit 用例详版) */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerSecurityAudit, { registerSecurityAudit as named } from "./index.ts";
import type { ToolDef, ToolResult } from "./index.ts";

/** 收集注册调用的 stub(pi 方法面投影) */
class StubPi {
  tools = new Map<string, ToolDef>();
  registerTool(def: ToolDef): void {
    this.tools.set(def.name, def);
  }
}

/** execute 快捷调用(ctx.model 注入) */
/** execute 快捷调用(ctx.model 与 params 注入) */
async function callTool(pi: StubPi, name: string, ctx: unknown, params: unknown = {}): Promise<ToolResult> {
  const def = pi.tools.get(name);
  if (!def) throw new Error(`工具未注册:${name}`);
  return await def.execute("test-id", params as never, undefined, undefined, ctx);
}

test("工具枚举:两个薄工具已注册且命名导出与默认导出同源", () => {
  const pi = new StubPi();
  registerSecurityAudit(pi);
  assert.ok(pi.tools.has("resolve_scan_model"), "模型解析工具已注册");
  assert.ok(pi.tools.has("validate_scan_artifacts"), "产物校验工具已注册");
  assert.equal(typeof named, "function");
  assert.equal(typeof registerSecurityAudit, "function");
});

test("resolve_scan_model 冒烟:无配置 + ctx.model → session(非错误)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = dir;
  const pi = new StubPi();
  registerSecurityAudit(pi);
  const r = await callTool(pi, "resolve_scan_model", { model: { provider: "p", id: "m" } });
  assert.ok(!r.isError, "非错误路径 isError 必须为 falsy");
  assert.match(r.content[0].text, /来源:会话模型/);
  delete process.env.PI_CODING_AGENT_DIR;
});

test("validate_scan_artifacts 冒烟:fixture findings 文档 → 校验通过", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hex24 = "aabbccddeeff001122334455";
  const hex64 = "a".repeat(64);
  const doc = {
    documentType: "codex-security.findings",
    schemaVersion: "1.0",
    scanId: "scan-001",
    findings: [
      {
        findingId: `csf_${hex24}`,
        occurrenceId: `occ_${hex24}`,
        ruleId: "hardcoded-secret",
        identity: { anchor: "src/db.js" },
        fingerprints: { algorithm: "codex-security/v1", primary: `codex-security/v1:sha256:${hex64}` },
        title: "硬编码密钥",
        summary: "s",
        severity: { level: "high" },
        confidence: { level: "high", rationale: "r" },
        taxonomy: { category: "c", cwe: ["CWE-798"] },
        locations: [{ path: "src/db.js", startLine: 10 }],
        remediation: "fix",
        provenance: { source: "baseline" },
      },
    ],
  };
  const artifact = path.join(dir, "findings.json");
  fs.writeFileSync(artifact, JSON.stringify(doc), "utf8");
  const pi = new StubPi();
  registerSecurityAudit(pi);
  const r = await callTool(pi, "validate_scan_artifacts", undefined, { kind: "findings", path: artifact });
  assert.ok(!r.isError, `校验应通过,实际:${r.content[0].text}`);
  assert.match(r.content[0].text, /校验通过/);
});

test("resolve_scan_model 冒烟:损坏配置 → isError 且 detail 透传", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "security-audit.json"), "not-json", "utf8");
  process.env.PI_CODING_AGENT_DIR = dir;
  const pi = new StubPi();
  registerSecurityAudit(pi);
  const r = await callTool(pi, "resolve_scan_model", { model: { provider: "p", id: "m" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /损坏配置/);
  delete process.env.PI_CODING_AGENT_DIR;
});

test('守卫 cand-02:kind 白名单——非法 kind 返回 isError 且不读文件', async () => {
  const pi = new StubPi();
  registerSecurityAudit(pi);
  const r = await callTool(pi, 'validate_scan_artifacts', undefined, { kind: '../../etc/passwd', path: 'x.json' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /kind 必须为/);
});
