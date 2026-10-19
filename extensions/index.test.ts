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
async function callTool(pi: StubPi, name: string, ctx: unknown): Promise<ToolResult> {
  const def = pi.tools.get(name);
  if (!def) throw new Error(`工具未注册:${name}`);
  return await def.execute("test-id", {} as never, undefined, undefined, ctx);
}

test("工具枚举:resolve_scan_model 已注册且命名导出与默认导出同源", () => {
  const pi = new StubPi();
  registerSecurityAudit(pi);
  assert.ok(pi.tools.has("resolve_scan_model"), "薄工具已注册");
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
