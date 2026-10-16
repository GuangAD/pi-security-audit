/**
 * extensions/run-executor.test.ts — executeRun / 白名单 契约测试(hermetic)
 *
 * 事实源:spec「extensions/run-executor.ts」节 pinned case + 机检铁律。
 * 假 cs fixture:PATH 前置目录放 cs.cmd(npm 垫片形态)+ fake-entry.js,
 * 行为由 FAKE_CS_* 环境变量控制,argv 捕获到 FAKE_CS_CAPTURE 指定文件。
 * 全程不调用真实 cs。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import {
  CS_SUBCOMMAND_WHITELIST,
  decideCsCommand,
  executeRun,
  normalizeRunTimeoutMs,
} from "./run-executor.ts";

// spec 固化截断标记(期望值来自契约文本,不 import 实现常量)
const TRUNCATION_MARKER = "…[截断]";

// —— cs 子命令全集(cs --help 固化于 2026-10-16,期望值独立于实现,来自任务简报事实 3) ——
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
];
const REJECTED_CS_SUBCOMMANDS = ["login", "logout", "mcp"];

// —— hermetic 假 cs fixture ——

/** fake-entry.js:CJS 直跑,捕获 argv、按 FAKE_CS_* 控制输出与退出行为 */
const FAKE_ENTRY_SOURCE = String.raw`const fs = require("node:fs");
const args = process.argv.slice(2);
const captureFile = process.env.FAKE_CS_CAPTURE;
if (captureFile) {
  fs.appendFileSync(captureFile, JSON.stringify({ argv: args, cwd: process.cwd() }) + "\n");
}
const text = process.env.FAKE_CS_OUTPUT_TEXT;
if (text) process.stdout.write(text);
const stderrText = process.env.FAKE_CS_STDERR_TEXT;
if (stderrText) process.stderr.write(stderrText);
const bytes = Number(process.env.FAKE_CS_OUTPUT_BYTES || "0");
if (bytes > 0) {
  const chunk = Buffer.alloc(4096, 0x41);
  let left = bytes;
  while (left > 0) {
    const n = Math.min(4096, left);
    process.stdout.write(n === 4096 ? chunk : chunk.subarray(0, n));
    left -= n;
  }
}
const code = Number(process.env.FAKE_CS_EXIT_MODE || "0");
const sleepMs = Number(process.env.FAKE_CS_SLEEP_MS || "0");
if (sleepMs > 0) {
  setTimeout(() => process.exit(code), sleepMs);
} else {
  process.exit(code);
}
`;

interface FakeCsFixture {
  fakeDir: string;
  captureFile: string;
  /** 每条记录:{ argv, cwd } JSON 行 */
  captures(): Array<{ argv: string[]; cwd: string }>;
}

/** PATH 前置假 cs + 隔离环境变量;返回 teardown(测试末尾必须调用) */
function installFakeCs(t: TestContext): FakeCsFixture {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cs-"));
  fs.writeFileSync(path.join(fakeDir, "cs.cmd"), `@ECHO off\r\nnode "%dp0%\\fake-entry.js" %*\r\n`, "utf8");
  fs.writeFileSync(path.join(fakeDir, "fake-entry.js"), FAKE_ENTRY_SOURCE, "utf8");
  const captureFile = path.join(fakeDir, "capture.jsonl");
  const saved = {
    PATH: process.env.PATH,
    FAKE_CS_CAPTURE: process.env.FAKE_CS_CAPTURE,
    FAKE_CS_OUTPUT_TEXT: process.env.FAKE_CS_OUTPUT_TEXT,
    FAKE_CS_STDERR_TEXT: process.env.FAKE_CS_STDERR_TEXT,
    FAKE_CS_OUTPUT_BYTES: process.env.FAKE_CS_OUTPUT_BYTES,
    FAKE_CS_EXIT_MODE: process.env.FAKE_CS_EXIT_MODE,
    FAKE_CS_SLEEP_MS: process.env.FAKE_CS_SLEEP_MS,
  };
  process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_CS_CAPTURE = captureFile;
  for (const key of ["FAKE_CS_OUTPUT_TEXT", "FAKE_CS_STDERR_TEXT", "FAKE_CS_OUTPUT_BYTES", "FAKE_CS_EXIT_MODE", "FAKE_CS_SLEEP_MS"]) {
    delete process.env[key];
  }
  t.after(() => {
    process.env.PATH = saved.PATH;
    for (const [key, value] of Object.entries(saved)) {
      if (key === "PATH") continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(fakeDir, { recursive: true, force: true });
  });
  return {
    fakeDir,
    captureFile,
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

// —— 白名单枚举机检(spec 机检铁律:24 个子命令逐一过判定) ——

describe("CS_SUBCOMMAND_WHITELIST / decideCsCommand 枚举机检", () => {
  it("24 个子命令逐一判定:恰好 login/logout/mcp 拒绝,其余放行", () => {
    const rejected: string[] = [];
    const allowed: string[] = [];
    for (const command of ALL_CS_SUBCOMMANDS) {
      if (decideCsCommand(command).allowed) allowed.push(command);
      else rejected.push(command);
    }
    assert.deepEqual(rejected.sort(), [...REJECTED_CS_SUBCOMMANDS].sort());
    assert.equal(allowed.length, 21);
  });

  it("CS_SUBCOMMAND_WHITELIST:ALLOWED ∪ REJECTED == 全集,两集不相交,大小 21/3", () => {
    assert.equal(CS_SUBCOMMAND_WHITELIST.ALLOWED.size, 21);
    assert.equal(CS_SUBCOMMAND_WHITELIST.REJECTED.size, 3);
    for (const command of REJECTED_CS_SUBCOMMANDS) {
      assert.ok(!CS_SUBCOMMAND_WHITELIST.ALLOWED.has(command));
      assert.ok(CS_SUBCOMMAND_WHITELIST.REJECTED.has(command));
    }
    for (const command of ALL_CS_SUBCOMMANDS) {
      assert.ok(
        CS_SUBCOMMAND_WHITELIST.ALLOWED.has(command) || CS_SUBCOMMAND_WHITELIST.REJECTED.has(command),
      );
    }
  });

  it("白名单外任意命令按 unknown 拒绝(不放行)", () => {
    for (const command of ["rm", "", "SCAN", "scanx", "help", "--help"]) {
      assert.equal(decideCsCommand(command).allowed, false);
    }
  });
});

// —— 超时参数归一化(数值预算:默认 600s、上限 3600s) ——

describe("normalizeRunTimeoutMs 数值预算", () => {
  it("缺省/≤0/非数 → 默认 600_000ms", () => {
    assert.equal(normalizeRunTimeoutMs(undefined), 600_000);
    assert.equal(normalizeRunTimeoutMs(0), 600_000);
    assert.equal(normalizeRunTimeoutMs(-1), 600_000);
    assert.equal(normalizeRunTimeoutMs(Number.NaN), 600_000);
    assert.equal(normalizeRunTimeoutMs("1000" as unknown as number), 600_000);
  });
  it(">3_600_000 按 3_600_000;正常值原样", () => {
    assert.equal(normalizeRunTimeoutMs(4_000_000), 3_600_000);
    assert.equal(normalizeRunTimeoutMs(1_234), 1_234);
  });
});

// —— executeRun pinned case(假 cs,不跑真实 cs) ——

describe("executeRun", () => {
  it("info 类透传:exit 0,输出含 sdkVersion,argv 原样到达子进程", async (t) => {
    const fake = installFakeCs(t);
    process.env.FAKE_CS_OUTPUT_TEXT = '{"sdkVersion":"0.3.0"}\n';
    const result = await executeRun("info", ["--json"]);
    assert.equal("exitCode" in result && result.exitCode, 0);
    assert.equal("truncated" in result && result.truncated, false);
    assert.ok("output" in result && result.output.includes("sdkVersion"));
    const captures = fake.captures();
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].argv, ["info", "--json"]);
  });

  it("login 拒绝:rejected + 「终端执行」指引,不 spawn 子进程", async (t) => {
    const fake = installFakeCs(t);
    const result = await executeRun("login", []);
    assert.equal("rejected" in result && result.rejected, true);
    assert.ok("reason" in result && result.reason.includes("终端执行"));
    assert.equal("command" in result && result.command, "login");
    assert.equal(fake.captures().length, 0);
  });

  it("logout 拒绝:rejected + 「终端执行」指引", async (t) => {
    installFakeCs(t);
    const result = await executeRun("logout", []);
    assert.ok("rejected" in result && result.rejected === true);
    assert.ok("reason" in result && result.reason.includes("终端执行"));
  });

  it("mcp 拒绝:rejected + 官方排除说明", async (t) => {
    installFakeCs(t);
    const result = await executeRun("mcp", []);
    assert.ok("rejected" in result && result.rejected === true);
    assert.ok("reason" in result && result.reason.includes("MCP"));
  });

  it("未知命令拒绝:rejected 附合法子命令清单", async (t) => {
    installFakeCs(t);
    const result = await executeRun("rm", ["-rf"]);
    assert.ok("rejected" in result && result.rejected === true);
    assert.ok("reason" in result && result.reason.includes("rm"));
    // 合法清单:抽查首尾与中段命令名
    for (const name of ["scan", "classify-severity", "bulk-scan", "skills"]) {
      assert.ok("reason" in result && result.reason.includes(name));
    }
  });

  it("超时杀进程树:timeoutMs=1 + 长睡 fixture → { timeout: true, timeoutMs: 1 }", async (t) => {
    installFakeCs(t);
    process.env.FAKE_CS_SLEEP_MS = "30000";
    const start = Date.now();
    const result = await executeRun("scans", [], { timeoutMs: 1 });
    assert.ok("timeout" in result && result.timeout === true);
    assert.ok("timeoutMs" in result && result.timeoutMs === 1);
    assert.ok(Date.now() - start < 10_000, "超时后应及时返回");
  });

  it("50KB 截断:60KB 输出 → truncated:true,长度 ≤ 50KB+标记,附标记", async (t) => {
    installFakeCs(t);
    process.env.FAKE_CS_OUTPUT_BYTES = "61440";
    const result = await executeRun("info", []);
    assert.ok("truncated" in result && result.truncated === true);
    assert.ok("output" in result);
    assert.ok(result.output.endsWith(TRUNCATION_MARKER));
    assert.ok(result.output.length <= 50 * 1024 + TRUNCATION_MARKER.length);
  });

  it("非零退出码透传:fixture exit 3 → exitCode 3", async (t) => {
    installFakeCs(t);
    process.env.FAKE_CS_EXIT_MODE = "3";
    process.env.FAKE_CS_STDERR_TEXT = "boom";
    const result = await executeRun("scan", ["--diff", "no-such-ref"]);
    assert.ok("exitCode" in result);
    assert.equal(result.exitCode, 3);
    assert.ok("output" in result && result.output.includes("boom"), "stdout+stderr 合并捕获");
    assert.ok("truncated" in result && result.truncated === false);
  });

  it("stderr 与 stdout 合并且保持到达顺序;超时外的正常退出不受 taskkill 影响", async (t) => {
    installFakeCs(t);
    process.env.FAKE_CS_OUTPUT_TEXT = "out-first";
    process.env.FAKE_CS_STDERR_TEXT = "err-second";
    const result = await executeRun("info", []);
    assert.ok("output" in result);
    assert.ok(result.output.indexOf("out-first") < result.output.indexOf("err-second"));
    assert.ok("exitCode" in result && result.exitCode === 0);
  });
});

