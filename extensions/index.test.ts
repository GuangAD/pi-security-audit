/**
 * extensions/index.test.ts — 装配层(pi 工具)契约测试(hermetic)
 *
 * 事实源:spec「extensions/index.ts(pi 工具)」节 pinned case + 覆盖声明
 * (错误映射枚举:接线失败 / 非 git / cs 缺失 / 非法 scope;成功结构化;完成通知;命令简写)。
 * stub ExtensionAPI 捕获 registerTool/registerCommand,直接调 def.execute。
 * 环境全隔离:PI_CODING_AGENT_DIR/CODEX_HOME 指向空临时目录,PATH 前置假 cs,不触真实 cs。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createExtension from "./index.ts";
import { activeScans, cleanup } from "./scan-runner.ts";

// —— stub ExtensionAPI ——

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}
interface ToolDef {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}
/** 从 content 数组抽出拼接文本(断言用) */
function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}
interface CommandDef {
  description?: string;
  handler: (args: string, ctx: unknown) => unknown;
}

class StubPi {
  tools = new Map<string, ToolDef>();
  commands = new Map<string, CommandDef>();
  events = new Map<string, () => void>();
  sentMessages: string[] = [];
  model: Record<string, unknown> | null = null;

  registerTool(def: ToolDef): void {
    this.tools.set(def.name ?? "", def);
  }
  registerCommand(name: string, def: CommandDef): void {
    this.commands.set(name, def);
  }
  on(event: string, handler: () => void): void {
    this.events.set(event, handler);
  }
  getModel(): unknown {
    return this.model;
  }
  sendUserMessage(message: string): unknown {
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

async function callTool(pi: StubPi, name: string, params: unknown): Promise<ToolResult> {
  const def = pi.tools.get(name);
  if (!def) throw new Error(`工具未注册:${name}`);
  return await def.execute("test-id", params, undefined, undefined, {});
}

// —— hermetic 隔离(假 cs + 隔离 agent-dir / CODEX_HOME / cwd) ——

/** fake-entry.js:与 run-executor.test.ts 同款垫片形态;argv 捕获 + FAKE_CS_* 行为控制 */
const FAKE_ENTRY_SOURCE = String.raw`const fs = require("node:fs");
const args = process.argv.slice(2);
const captureFile = process.env.FAKE_CS_CAPTURE;
if (captureFile) {
  fs.appendFileSync(captureFile, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
}
const text = process.env.FAKE_CS_OUTPUT_TEXT;
if (text) process.stdout.write(text);
const code = Number(process.env.FAKE_CS_EXIT_MODE || "0");
const sleepMs = Number(process.env.FAKE_CS_SLEEP_MS || "0");
if (sleepMs > 0) {
  setTimeout(() => process.exit(code), sleepMs);
} else {
  process.exit(code);
}
`;

interface Isolation {
  agentDir: string;
  codexHome: string;
  repoDir: string;
  captures(): Array<{ argv: string[]; cwd: string }>;
}

/** 全量环境隔离;t.after 恢复 PATH/env/cwd、清注册表、删临时目录 */
function isolate(
  t: TestContext,
  opts?: { git?: boolean; fakeCs?: boolean; zaiKey?: string },
): Isolation {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  if (opts?.git) fs.mkdirSync(path.join(repoDir, ".git"));

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cs-"));
  const captureFile = path.join(fakeDir, "capture.jsonl");
  if (opts?.fakeCs) {
    fs.writeFileSync(path.join(fakeDir, "cs.cmd"), `@ECHO off\r\nnode "%dp0%\\fake-entry.js" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(fakeDir, "fake-entry.js"), FAKE_ENTRY_SOURCE, "utf8");
  }

  const saved = {
    PATH: process.env.PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    FAKE_CS_CAPTURE: process.env.FAKE_CS_CAPTURE,
  };
  const savedCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CODEX_HOME = codexHome;
  if (opts?.zaiKey !== undefined) process.env.ZAI_API_KEY = opts.zaiKey;
  else delete process.env.ZAI_API_KEY;
  if (opts?.fakeCs) {
    process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.FAKE_CS_CAPTURE = captureFile;
  }

  t.after(() => {
    process.chdir(savedCwd);
    process.env.PATH = saved.PATH;
    for (const key of ["CODEX_HOME", "PI_CODING_AGENT_DIR", "FAKE_CS_CAPTURE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    if (saved.ZAI_API_KEY === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = saved.ZAI_API_KEY;
    cleanup();
    for (const dir of [agentDir, codexHome, repoDir, fakeDir]) {
      // detached 假 cs 子进程的 cwd 可能仍指向 repoDir:Windows 下活进程 cwd 不可删,重试 + 最终容忍
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      } catch {
        /* 残留临时目录交由系统 tmp 清理;不以 teardown EPERM 判测试失败 */
      }
    }
  });

  return {
    agentDir,
    codexHome,
    repoDir,
    captures(): Array<{ argv: string[]; cwd: string }> {
      try {
        return fs
          .readFileSync(captureFile, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

/** 兼容会话模型(responses 直连 + env 凭证可解析) */
const RESPONSES_MODEL = {
  id: "glm-test",
  provider: "zai-test",
  baseUrl: "https://api.z.ai/api/v1",
  api: "openai-responses",
};
const ANTHROPIC_MODEL = {
  id: "claude-test",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  api: "anthropic-messages",
};

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// —— codex_security_scan.execute ——

describe("codex_security_scan 错误映射(spec 覆盖声明:全部 reason 逐一 isError 且 detail 非空)", () => {
  it("接线失败:协议不兼容 → isError 含「/model」与覆盖配置指引", async (t) => {
    isolate(t);
    const pi = new StubPi();
    pi.model = ANTHROPIC_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_scan", { scope: { kind: "diff", base: "origin/main" } });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("/model"));
    assert.ok(textOf(result).includes("codex-security.json"));
  });

  it("接线失败:无凭证 → isError 含 API key 指引", async (t) => {
    isolate(t);
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_scan", { scope: { kind: "diff", base: "origin/main" } });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("API key"));
  });

  it("startScan 失败:非 git 仓库 → isError 含 .git 指引", async (t) => {
    const iso = isolate(t, { git: false, zaiKey: "TESTKEY_SENTINEL" });
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    // chdir 到隔离的非 git 仓库(startScan 预检以 cwd 为 repoPath)
    const savedCwd = process.cwd();
    process.chdir(iso.repoDir);
    const result = await callTool(pi, "codex_security_scan", { scope: { kind: "diff", base: "origin/main" } });
    process.chdir(savedCwd);
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes(".git"));
  });

  it("startScan 失败:非法 scope → isError 含参数校验原文", async (t) => {
    isolate(t);
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    process.env.ZAI_API_KEY = "TESTKEY_SENTINEL";
    const result = await callTool(pi, "codex_security_scan", { scope: { kind: "diff", base: "" } });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("非法扫描参数"));
  });

  it("startScan 失败:cs 缺失 → isError 含 PATH 指引", async (t) => {
    const iso = isolate(t, { git: true, zaiKey: "TESTKEY_SENTINEL" });
    process.env.PATH = ""; // 清空 PATH:cs 不可解析
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const savedCwd = process.cwd();
    process.chdir(iso.repoDir);
    const result = await callTool(pi, "codex_security_scan", { scope: { kind: "diff", base: "origin/main" } });
    process.chdir(savedCwd);
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("不在 PATH"));
  });
});

describe("codex_security_scan 成功路径 + 完成通知", () => {
  it("成功返回结构化句柄;modelOverride 在装配层生效;完成后 sendUserMessage 含 codex_security_status", async (t) => {
    const iso = isolate(t, { git: true, fakeCs: true, zaiKey: "TESTKEY_SENTINEL_12345" });
    process.chdir(iso.repoDir);
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_scan", {
      scope: { kind: "diff", base: "origin/main" },
      modelOverride: "glm-override-9",
    });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as {
      scanDir: string;
      pid: number;
      command: string;
      logPath: string;
      statePath: string;
      startedAt: string;
    };
    assert.equal(typeof structured.scanDir, "string");
    assert.equal(typeof structured.pid, "number");
    assert.ok(structured.command.includes("--diff origin/main"));
    assert.ok(!structured.command.includes("TESTKEY_SENTINEL_12345"), "命令面零密钥明文(红线)");
    // modelOverride 只换模型 id,端点/凭证解析不变(等子进程把 argv 落捕获文件)
    await waitFor(() => iso.captures().length > 0);
    const argv = iso.captures()[0]?.argv ?? [];
    assert.ok(argv.includes("glm-override-9"));
    assert.ok(!argv.includes("glm-test"));
    // 完成通知:假 cs 快退后 sendUserMessage 被调用且指引 status
    await waitFor(() => pi.sentMessages.length > 0);
    assert.ok(pi.sentMessages[0].includes("codex_security_status"));
    assert.ok(pi.sentMessages[0].includes(structured.scanDir));
  });
});

// —— codex_security_status.execute ——

/** 构造已完成扫描产物目录(state.json pid 为不存活值 + artifacts/report.md) */
function makeCompletedScanDir(opts?: { findings?: unknown }): string {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "scandir-"));
  fs.writeFileSync(
    path.join(scanDir, "state.json"),
    JSON.stringify({
      scanDir,
      pid: 999999999,
      commandRedacted: "cs scan ...",
      repoPath: process.cwd(),
      startedAt: new Date().toISOString(),
      params: { scope: { kind: "diff", base: "origin/main" } },
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(scanDir, "artifacts"));
  fs.writeFileSync(path.join(scanDir, "artifacts", "report.md"), "# report\n", "utf8");
  if (opts?.findings !== undefined) {
    fs.writeFileSync(path.join(scanDir, "artifacts", "findings.json"), JSON.stringify(opts.findings), "utf8");
  }
  return scanDir;
}

describe("codex_security_status", () => {
  it("completed:structuredContent 含 reportPath 与 summary(counts 精确)", async (t) => {
    isolate(t);
    const scanDir = makeCompletedScanDir({
      findings: {
        findings: [
          { severity: { level: "critical" }, locations: ["a.ts:1"], codeEvidence: "eval(input)" },
          { severity: { level: "high" }, locations: ["b.ts:2"], codeEvidence: "x" },
        ],
      },
    });
    t.after(() => fs.rmSync(scanDir, { recursive: true, force: true }));
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_status", { scanDir });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as {
      phase: string;
      reportPath: string;
      summary: { counts: Record<string, number>; source: string };
    };
    assert.equal(structured.phase, "completed");
    assert.ok(structured.reportPath.endsWith("report.md"));
    assert.deepEqual(structured.summary.counts, { critical: 1, high: 1, medium: 0, low: 0 });
    assert.equal(structured.summary.source, "findings-json");
  });

  it("degraded:findings.json 不可解析 → 结构化结果带 degraded 与 reportPath", async (t) => {
    isolate(t);
    const scanDir = makeCompletedScanDir();
    t.after(() => fs.rmSync(scanDir, { recursive: true, force: true }));
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_status", { scanDir });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as { phase: string; degraded?: boolean; reportPath?: string };
    assert.equal(structured.degraded, true);
    assert.ok(typeof structured.reportPath === "string" && structured.reportPath.endsWith("report.md"));
  });

  it("scanDir 非法(相对路径)→ isError", async (t) => {
    isolate(t);
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_status", { scanDir: "../" });
    assert.equal(result.isError, true);
  });

  it("scanDir 合法但不存在 → phase unknown 且 detail 非空(非 isError)", async (t) => {
    isolate(t);
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const missing = path.join(os.tmpdir(), "no-such-scan-dir-xyz");
    const result = await callTool(pi, "codex_security_status", { scanDir: missing });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as { phase: string; detail?: string };
    assert.equal(structured.phase, "unknown");
    assert.ok(structured.detail && structured.detail.length > 0);
  });
});

// —— codex_security_run.execute ——

describe("codex_security_run 错误映射与透传", () => {
  it("login rejected → isError 含「终端执行」", async (t) => {
    isolate(t);
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_run", { command: "login" });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("终端执行"));
  });

  it("成功透传:content 含 output 与 exitCode,structuredContent 同步", async (t) => {
    isolate(t, { fakeCs: true });
    process.env.FAKE_CS_OUTPUT_TEXT = '{"sdkVersion":"0.3.0"}\n';
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_run", { command: "info" });
    assert.notEqual(result.isError, true);
    assert.ok(textOf(result).includes("sdkVersion"));
    const structured = result.structuredContent as { exitCode: number; output: string; truncated: boolean };
    assert.equal(structured.exitCode, 0);
    assert.ok(structured.output.includes("sdkVersion"));
    assert.equal(structured.truncated, false);
  });

  it("超时 → isError 含超时说明", async (t) => {
    isolate(t, { fakeCs: true });
    process.env.FAKE_CS_SLEEP_MS = "30000";
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const result = await callTool(pi, "codex_security_run", { command: "scans", timeoutMs: 1 });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes("超时"));
  });
});

// —— /security-scan 命令与 session_shutdown ——

describe("/security-scan 命令", () => {
  it("无参默认 diff origin/main,结果经 ui.notify 呈现", async (t) => {
    const iso = isolate(t, { git: true, fakeCs: true, zaiKey: "TESTKEY_SENTINEL_12345" });
    process.chdir(iso.repoDir);
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const notified: string[] = [];
    const def = pi.commands.get("security-scan");
    assert.ok(def, "security-scan 命令已注册");
    await def.handler("", { ui: { notify: (message: string) => notified.push(message) } });
    await waitFor(() => iso.captures().length > 0);
    const argv = iso.captures()[0]?.argv ?? [];
    assert.deepEqual(argv.slice(argv.indexOf("--diff"), argv.indexOf("--diff") + 2), ["--diff", "origin/main"]);
    assert.ok(notified.length > 0 && notified[0].includes("scanDir"));
  });

  it("working-tree 简写 → workingTree 范围", async (t) => {
    const iso = isolate(t, { git: true, fakeCs: true, zaiKey: "TESTKEY_SENTINEL_12345" });
    process.chdir(iso.repoDir);
    const pi = new StubPi();
    pi.model = RESPONSES_MODEL;
    createExtension(pi as unknown as ExtensionAPI);
    const def = pi.commands.get("security-scan");
    assert.ok(def);
    await def.handler("working-tree", { ui: { notify: () => undefined } });
    await waitFor(() => iso.captures().length > 0);
    const argv = iso.captures()[0]?.argv ?? [];
    assert.ok(argv.includes("--working-tree"));
    assert.ok(!argv.includes("--diff"));
  });
});

describe("session_shutdown", () => {
  it("已注册且调用 cleanup(清空注册表)", () => {
    const pi = new StubPi();
    createExtension(pi as unknown as ExtensionAPI);
    const handler = pi.events.get("session_shutdown");
    assert.ok(handler, "session_shutdown 事件已注册(pi.on)");
    activeScans.set(1, { pid: 1, scanDir: "x", child: { removeListener: () => undefined } as never, exited: false, onExit: () => undefined });
    handler();
    assert.equal(activeScans.size, 0);
  });
});
