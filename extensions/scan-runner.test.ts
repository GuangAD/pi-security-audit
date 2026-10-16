/**
 * extensions/scan-runner.test.ts — startScan / getScanStatus 机检
 *
 * 事实源:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/scan-runner.ts」节
 * (pinned case 用例表、等价类矩阵 6 组合全枚举、机检铁律 2 条、数值预算)。
 * 期望值全部为独立构造的字面量(cs --help 参数表、spec 数据结构),不用被测代码的算法重算。
 *
 * 测试一律 hermetic:假 cs fixture(PATH 前置 cs.cmd + 假入口脚本,捕获 argv 后按 env 退出/沉睡),
 * CODEX_HOME 指向临时目录(不污染真实 ~/.codex);仅 Windows 入口解析含一次对真实 cs.cmd 的只读解析。
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";

import {
  startScan,
  getScanStatus,
  cleanup,
  activeScans,
  resolveCsSpawnTarget,
  parseNpmShimEntry,
  type ScanParams,
  type ScanHandle,
  type ScanStateFile,
} from "./scan-runner.ts";
import type { LlmWiring } from "./llm-wiring.ts";

/** 密钥脱敏哨兵(AGENTS.md 密钥红线):只允许出现在 wiring.env 值,任何落盘/命令面不得出现 */
const KEY = "TESTKEY_SENTINEL_12345";

const isWin = process.platform === "win32";

// —— 测试环境:临时 CODEX_HOME + 假 cs fixture + git 仓库 fixture ——

let tmpRoot: string;
let codexHome: string;
let fixtureBin: string;
let repoDir: string;
let nonRepoDir: string;
const savedEnv = new Map<string, string | undefined>();
const trackedChildren: ChildProcess[] = [];
let captureCounter = 0;
let manualCounter = 0;

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}
function restoreSavedEnvs(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

/** 假 cs 入口脚本:捕获 argv 到 JSON 文件,stdout 打点(进日志),按 env 决定退出模式 */
const FAKE_ENTRY_JS = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = process.env.FAKE_CS_CAPTURE;
if (out) {
  try {
    fs.writeFileSync(out, JSON.stringify({ args, cwd: process.cwd(), envTestKey: process.env.TEST_ENV_KEY || null }));
  } catch {}
}
process.stdout.write("fake-cs: started\\n");
if ((process.env.FAKE_CS_EXIT_MODE || "sleep") === "exit0") process.exit(0);
setTimeout(() => { process.stdout.write("late-marker\\n"); process.exit(0); }, Number(process.env.FAKE_CS_SLEEP_MS || 60000));
`;

/** 下一个唯一 CAPTURE 文件路径(每次 startScan 前调用) */
function nextCapturePath(): string {
  return path.join(tmpRoot, `capture-${captureCounter++}.json`);
}
function readCapture(file: string): { args: string[]; cwd: string; envTestKey: string | null } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时等待:${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killAndAwait(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
}

/** 已退出子进程的 pid(死 pid 情形;spawnSync 返回时进程必已退出) */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(result.pid !== undefined, "无法取得已退出进程的 pid");
  return result.pid;
}

/** 手工构造扫描目录(state.json / scan.log / artifacts/report.md 按需),用于 getScanStatus 组合枚举 */
function makeStateDir(opts: { pid: number; report?: boolean; log?: string }): string {
  const dir = path.join(tmpRoot, "manual-scans", `scan-${manualCounter++}`);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  if (opts.report) fs.writeFileSync(path.join(dir, "artifacts", "report.md"), "# report\n");
  if (opts.log !== undefined) fs.writeFileSync(path.join(dir, "scan.log"), opts.log);
  const state: ScanStateFile = {
    scanDir: dir,
    pid: opts.pid,
    commandRedacted: "cs scan . --working-tree",
    repoPath: repoDir,
    startedAt: new Date().toISOString(),
    params: { scope: { kind: "workingTree" } },
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
  return dir;
}

/** 接线 fixture(形状对齐 llm-wiring 输出:五类键 + 单键 env) */
const WIRING: LlmWiring = {
  codexArgs: [
    `model_provider="testprov"`,
    `model_providers.testprov.name="testprov"`,
    `model_providers.testprov.base_url="https://llm.test/v1"`,
    `model_providers.testprov.wire_api="responses"`,
    `model_providers.testprov.env_key="TEST_ENV_KEY"`,
  ],
  env: { TEST_ENV_KEY: KEY },
  model: "test-model-1",
  source: "session",
};

const DIFF_PARAMS: ScanParams = { scope: { kind: "diff", base: "origin/main" } };

/** 清空注册表并等待其下子进程退出的收尾(每个启动过扫描的用例末尾调用) */
function shutdownScans(): void {
  const pids = [...activeScans.keys()];
  cleanup();
  for (const pid of pids) killAndAwait(pid);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scanrunner-"));
  codexHome = path.join(tmpRoot, "codex-home");
  fixtureBin = path.join(tmpRoot, "fixture-bin");
  repoDir = path.join(tmpRoot, "repo");
  nonRepoDir = path.join(tmpRoot, "not-a-repo");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(fixtureBin, { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.mkdirSync(nonRepoDir, { recursive: true });
  // 假 cs fixture:npm 垫片形态 cs.cmd(%dp0% 引用 + 引号包裹的 .js 入口),解析器逻辑与真实垫片通用
  fs.writeFileSync(path.join(fixtureBin, "fake-entry.js"), FAKE_ENTRY_JS, "utf8");
  fs.writeFileSync(
    path.join(fixtureBin, "cs.cmd"),
    `@ECHO off\r\nnode "%dp0%\\fake-entry.js" %*\r\n`,
    "utf8",
  );
  setEnv("CODEX_HOME", codexHome);
  setEnv("PATH", `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`);
  setEnv("TEST_ENV_KEY", KEY);
});

after(() => {
  shutdownScans();
  for (const child of trackedChildren) {
    if (child.pid !== undefined) killAndAwait(child.pid);
  }
  restoreSavedEnvs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  shutdownScans();
});

// —— 用例组 A:startScan 预检(非法 scope / 非 git 仓库 / cs 缺失;均不 mkdir 不 spawn) ——

test("非法 scope 即失败:diff.base 空串,注册表计数为证未 spawn", async () => {
  await assert.rejects(
    startScan({ scope: { kind: "diff", base: "" } }, WIRING, repoDir),
    /base/,
  );
  assert.equal(activeScans.size, 0);
});

test("非法 scope 即失败:paths 空数组 / paths 含空串 / workingTree.base 空串 / mode 非法", async () => {
  for (const bad of [
    { scope: { kind: "paths" as const, paths: [] } },
    { scope: { kind: "paths" as const, paths: ["src/a.ts", ""] } },
    { scope: { kind: "workingTree" as const, base: "" } },
    { scope: { kind: "diff" as const, base: "origin/main" }, mode: "ultra" as const },
  ]) {
    await assert.rejects(startScan(bad as ScanParams, WIRING, repoDir), /扫描参数|范围|mode/i);
  }
  assert.equal(activeScans.size, 0);
});

test("非 git 仓库抛错含 git 指引,无产物目录残留", async () => {
  await assert.rejects(startScan(DIFF_PARAMS, WIRING, nonRepoDir), /git/);
  assert.equal(activeScans.size, 0);
  const residue = path.join(codexHome, "plugins", "codex-security", "scans", path.basename(nonRepoDir));
  assert.ok(!fs.existsSync(residue), `预检失败不应留下产物目录:${residue}`);
});

test("cs 不在 PATH 抛可读错误(不含密钥)", async () => {
  const emptyBin = path.join(tmpRoot, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const saved = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    await assert.rejects(startScan(DIFF_PARAMS, WIRING, repoDir), (err: Error) => {
      assert.match(err.message, /cs/);
      assert.ok(!err.message.includes(KEY), "错误消息不得含密钥明文");
      return true;
    });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(activeScans.size, 0);
});
// —— 断言辅助:独立 shell 风格 join/split(铁律「args 可逆拼装」的逆向 oracle,独立于实现) ——

/** 独立 join:含空白/引号/反斜杠的词元加双引号,内部 \" 与 \\ 转义 */
function shellJoin(tokens: string[]): string {
  return tokens
    .map((t) => {
      if (!/[\s"\\]/.test(t)) return t;
      return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

/** 独立 split:双引号内 \" 与 \\ 为转义对,空白分词(与 join 互逆) */
function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let hasToken = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (inQuote) {
      if (c === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) {
        cur += cmd[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuote = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      hasToken = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      if (hasToken) out.push(cur);
      cur = "";
      hasToken = false;
      i++;
      continue;
    }
    cur += c;
    hasToken = true;
    i++;
  }
  if (hasToken) out.push(cur);
  return out;
}

/** 启动一次扫描并等待假 cs 捕获 argv;返回句柄与捕获结果 */
async function startAndCapture(params: ScanParams): Promise<{ handle: ScanHandle; cap: { args: string[]; cwd: string; envTestKey: string | null } }> {
  const captureFile = nextCapturePath();
  setEnv("FAKE_CS_CAPTURE", captureFile);
  const handle = await startScan(params, WIRING, repoDir);
  await waitFor(() => fs.existsSync(captureFile), `假 cs 捕获 argv(${captureFile})`);
  return { handle, cap: readCapture(captureFile) };
}

/** codex 注入参数展开为 argv 片段(--codex <arg> 逐对) */
const CODEX_FLAT = WIRING.codexArgs.flatMap((a) => ["--codex", a]);

// —— 用例组 B:startScan 后置条件(句柄 / args 拼装 6 组合 / 脱敏 / 并发 / 铁律) ——

test("句柄后置:绝对路径已存在、artifacts 为空目录、state.json 与 ScanStateFile 一致、命令脱敏", async () => {
  const { handle, cap } = await startAndCapture(DIFF_PARAMS);

  assert.ok(path.isAbsolute(handle.scanDir) && fs.existsSync(handle.scanDir));
  assert.ok(path.isAbsolute(handle.logPath) && fs.existsSync(handle.logPath));
  assert.ok(path.isAbsolute(handle.statePath) && fs.existsSync(handle.statePath));
  assert.equal(fs.readdirSync(path.join(handle.scanDir, "artifacts")).length, 0, "artifacts 应为空目录(cs 要求)");
  assert.equal(fs.readdirSync(handle.scanDir).sort().join(","), "artifacts,scan.log,state.json");

  // command 脱敏:含 $ENV 引用,不含明文 key
  assert.match(handle.command, /\$\w+/);
  assert.ok(!handle.command.includes(KEY), "command 不得含明文 key");
  assert.ok(handle.command.includes("$TEST_ENV_KEY"));

  // state.json 与 ScanStateFile 契约一致;原子写无临时文件残留
  const state = JSON.parse(fs.readFileSync(handle.statePath, "utf8")) as ScanStateFile;
  assert.deepEqual(state, {
    scanDir: handle.scanDir,
    pid: handle.pid,
    commandRedacted: handle.command,
    repoPath: path.resolve(repoDir),
    startedAt: handle.startedAt,
    params: DIFF_PARAMS,
  });
  assert.ok(!state.commandRedacted.includes(KEY), "commandRedacted 不得含明文 key");
  assert.equal(
    fs.readdirSync(handle.scanDir).filter((f) => f.endsWith(".tmp")).length,
    0,
    "原子写不得残留临时文件",
  );

  // 子进程真实启动:cwd 为仓库根,env 注入 wiring.env(key 只走 env)
  assert.equal(cap.cwd, path.resolve(repoDir));
  assert.equal(cap.envTestKey, KEY);

  killAndAwait(handle.pid);
  await waitFor(() => !isPidAlive(handle.pid), "假 cs 退出");
});

test("args 拼装 6 组合全枚举:scope(3) × mode(2),逐元素相等", async () => {
  const combos: Array<{ params: ScanParams; scopeArgs: string[] }> = [
    { params: { scope: { kind: "diff", base: "origin/main" }, mode: "standard" }, scopeArgs: ["--diff", "origin/main"] },
    { params: { scope: { kind: "diff", base: "origin/main" }, mode: "deep" }, scopeArgs: ["--diff", "origin/main"] },
    { params: { scope: { kind: "workingTree" }, mode: "standard" }, scopeArgs: ["--working-tree"] },
    { params: { scope: { kind: "workingTree" }, mode: "deep" }, scopeArgs: ["--working-tree"] },
    { params: { scope: { kind: "paths", paths: ["src/a.ts", "src/b.ts"] }, mode: "standard" }, scopeArgs: ["--path", "src/a.ts", "--path", "src/b.ts"] },
    { params: { scope: { kind: "paths", paths: ["src/a.ts", "src/b.ts"] }, mode: "deep" }, scopeArgs: ["--path", "src/a.ts", "--path", "src/b.ts"] },
  ];
  for (const { params, scopeArgs } of combos) {
    const { handle, cap } = await startAndCapture(params);
    const expected = [
      "scan",
      ".",
      ...scopeArgs,
      "--mode",
      params.mode as string,
      "--headless",
      "--output-dir",
      path.join(handle.scanDir, "artifacts"),
      ...CODEX_FLAT,
      "--model",
      WIRING.model,
    ];
    assert.deepEqual(cap.args, expected, `组合 ${JSON.stringify(params)} 拼装不一致`);
    killAndAwait(handle.pid);
    await waitFor(() => !isPidAlive(handle.pid), "假 cs 退出");
  }
});

test("可选参数拼装:diff.head、workingTree.base、mode 缺省不拼 --mode", async () => {
  {
    const { handle, cap } = await startAndCapture({ scope: { kind: "diff", base: "origin/main", head: "HEAD" } });
    assert.deepEqual(cap.args.slice(0, 5), ["scan", ".", "--diff", "origin/main", "--head"]);
    assert.equal(cap.args[5], "HEAD");
    killAndAwait(handle.pid);
  }
  {
    const { handle, cap } = await startAndCapture({ scope: { kind: "workingTree", base: "HEAD" } });
    assert.deepEqual(cap.args.slice(0, 5), ["scan", ".", "--working-tree", "--base", "HEAD"]);
    killAndAwait(handle.pid);
  }
  {
    const { handle, cap } = await startAndCapture(DIFF_PARAMS);
    assert.ok(!cap.args.includes("--mode"), "mode 缺省时不得拼 --mode");
    killAndAwait(handle.pid);
  }
  await waitFor(() => [...activeScans.values()].every((e) => e.exited), "假 cs 全部退出");
});

test("并发超限(数值预算 ≤2):第 3 次抛 concurrent-scan-limit,释放后可再起", async () => {
  const h1 = await startAndCapture(DIFF_PARAMS);
  const h2 = await startAndCapture(DIFF_PARAMS);
  assert.notEqual(h1.handle.scanDir, h2.handle.scanDir, "同秒同 pid 须碰撞加后缀,目录不得相同");
  assert.equal(activeScans.size, 2);

  await assert.rejects(startScan(DIFF_PARAMS, WIRING, repoDir), /concurrent-scan-limit/);
  assert.equal(activeScans.size, 2, "被拒调用不得入注册表");

  killAndAwait(h1.handle.pid);
  killAndAwait(h2.handle.pid);
  await waitFor(() => [...activeScans.values()].every((e) => e.exited), "两个假 cs 退出登记");

  const h3 = await startAndCapture(DIFF_PARAMS);
  assert.ok(h3.handle.pid > 0, "并发释放后应能再次启动");
  killAndAwait(h3.handle.pid);
  await waitFor(() => !isPidAlive(h3.handle.pid), "假 cs 退出");
});

test("cleanup 只清注册表与监听,不杀扫描进程", async () => {
  const { handle } = await startAndCapture(DIFF_PARAMS);
  assert.equal(activeScans.size, 1);

  cleanup();

  assert.equal(activeScans.size, 0, "cleanup 后注册表为空");
  assert.ok(isPidAlive(handle.pid), "cleanup 不得杀扫描进程");

  killAndAwait(handle.pid);
  await waitFor(() => !isPidAlive(handle.pid), "假 cs 退出");
});

test("铁律1:args 可逆拼装(独立 join/split 往返还原相等,含空格与引号路径 argv 保真)", async () => {
  const tricky: ScanParams = {
    scope: { kind: "paths", paths: ['src/dir with space/a.ts', 'src/quote"dir/b.ts'] },
  };
  const { handle, cap } = await startAndCapture(tricky);

  // 独立往返:join → split 还原 args
  assert.deepEqual(shellSplit(shellJoin(cap.args)), cap.args);
  // 被测实现的命令行渲染(剥去 NAME=$NAME 前缀)还原 = 可执行名 + args
  const tail = handle.command.replace(/^\S+=\$\S+ /, "");
  const spawnTarget = resolveCsSpawnTarget();
  const expectedPrefix = process.platform === "win32" ? [spawnTarget.command, ...spawnTarget.prefixArgs] : ["cs"];
  assert.deepEqual(shellSplit(tail), [...expectedPrefix, ...cap.args]);
  // argv 保真:带空格与内嵌引号的路径原样到达子进程
  assert.equal(cap.args[2], "--path");
  assert.equal(cap.args[3], "src/dir with space/a.ts");
  assert.equal(cap.args[5], 'src/quote"dir/b.ts');

  killAndAwait(handle.pid);
  await waitFor(() => !isPidAlive(handle.pid), "假 cs 退出");
});

test("铁律2:scanDir 全部文件文本不含 key 哨兵串", async () => {
  const { handle } = await startAndCapture(DIFF_PARAMS);
  killAndAwait(handle.pid);
  await waitFor(() => !isPidAlive(handle.pid), "假 cs 退出");

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (fs.readFileSync(p, "utf8").includes(KEY)) offenders.push(p);
    }
  };
  walk(handle.scanDir);
  assert.deepEqual(offenders, [], `以下文件泄漏 key 明文:${offenders.join(", ")}`);
});

test("守卫(评审 Important):父进程退出后子进程日志仍完整(fd 直传,不经父进程管道)", async () => {
  // 辅助进程调 startScan 后立即退出;假 cs 先写 early、睡 1.5s、再写 late-marker。
  // stdio 走父进程管道时:辅助进程退出 → 管道读端关闭 → 假 cs 续写 EPIPE 崩溃,late-marker 缺失;
  // stdio 直传日志 fd 时:假 cs 直写文件,late-marker 必达。
  const helperPath = path.join(tmpRoot, "helper-exit-parent.ts");
  const scanRunnerUrl = new URL("./scan-runner.ts", import.meta.url).href;
  fs.writeFileSync(
    helperPath,
    `import { startScan } from ${JSON.stringify(scanRunnerUrl)};\n` +
      `const wiring = { codexArgs: ['model_provider="p"'], env: { TEST_ENV_KEY: "TESTKEY_SENTINEL_12345" }, model: "m", source: "session" };\n` +
      `const handle = await startScan({ scope: { kind: "workingTree" } }, wiring, ${JSON.stringify(repoDir)});\n` +
      `console.log(JSON.stringify({ pid: handle.pid, scanDir: handle.scanDir }));\n` +
      `process.exit(0);\n`,
    "utf8",
  );
  setEnv("FAKE_CS_SLEEP_MS", "1500");
  setEnv("FAKE_CS_CAPTURE", "");
  const helper = spawnSync(process.execPath, [helperPath], { encoding: "utf8", env: process.env });
  assert.equal(helper.status, 0, `辅助进程应退出 0:${helper.stderr}`);
  const { pid, scanDir } = JSON.parse(helper.stdout.trim().split("\n").pop()!);
  // 等假 cs(已脱离)自然写完 late-marker 并退出
  const logPath = path.join(scanDir, "scan.log");
  const deadline = Date.now() + 10000;
  let log = "";
  while (Date.now() < deadline) {
    try { log = fs.readFileSync(logPath, "utf8"); } catch { log = ""; }
    if (log.includes("late-marker")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(log.includes("fake-cs: started"), "early 输出应在日志");
  assert.ok(log.includes("late-marker"), `父进程退出后子进程续写应直达日志(管道版此处置红);实得日志:${JSON.stringify(log.slice(0, 200))}`);
  killAndAwait(pid);
});

// —— 用例组 B3:getScanStatus 状态机(pid 活/死 × report 有/无 全枚举 + 降级态 + logTail 铁律) ——

test("getScanStatus 4 组合全枚举:pid(活/死) × artifacts/report.md(有/无)", async () => {
  const combos = [
    { pidAlive: true, report: true, phase: "running" },
    { pidAlive: true, report: false, phase: "running" },
    { pidAlive: false, report: true, phase: "completed" },
    { pidAlive: false, report: false, phase: "failed" },
  ] as const;
  for (const c of combos) {
    const dir = makeStateDir({ pid: c.pidAlive ? process.pid : deadPid(), report: c.report });
    const status = await getScanStatus(dir);
    assert.equal(status.phase, c.phase, `pidAlive=${c.pidAlive} report=${c.report} 应为 ${c.phase}`);
    assert.equal(status.pidAlive, c.pidAlive);
  }
});

test("getScanStatus pinned:重启恢复查询(死 pid + report 在)→ completed 且 reportPath 非空", async () => {
  const dir = makeStateDir({ pid: deadPid(), report: true });
  const status = await getScanStatus(dir);
  assert.equal(status.phase, "completed");
  assert.ok(status.reportPath, "completed 应带 reportPath");
  assert.ok(fs.existsSync(status.reportPath!), "reportPath 应指向存在的文件");
  assert.ok(status.reportPath!.endsWith(path.join("artifacts", "report.md")), "reportPath 应为 <scanDir>/artifacts/report.md");
});

test("getScanStatus pinned:失败态(死 pid + 无 report)→ failed 且 detail 非空", async () => {
  const dir = makeStateDir({ pid: deadPid(), log: "some failure log\n" });
  const status = await getScanStatus(dir);
  assert.equal(status.phase, "failed");
  assert.ok(status.detail && status.detail.length > 0, "failed 应带 detail 说明");
});

test("getScanStatus pinned:目录不存在 → unknown 带 detail,不抛", async () => {
  const status = await getScanStatus(path.join(tmpRoot, "no-such-scan-dir"));
  assert.equal(status.phase, "unknown");
  assert.ok(status.detail && status.detail.length > 0, "unknown 应带 detail");
});

test("getScanStatus 降级态:state.json 缺失 → unknown;内容缺 pid → unknown,均不抛", async () => {
  const noState = path.join(tmpRoot, "manual-scans", `no-state-${manualCounter++}`);
  fs.mkdirSync(path.join(noState, "artifacts"), { recursive: true });
  const s1 = await getScanStatus(noState);
  assert.equal(s1.phase, "unknown");
  const badState = makeStateDir({ pid: deadPid() });
  fs.writeFileSync(path.join(badState, "state.json"), JSON.stringify({ scanDir: badState }), "utf8");
  const s2 = await getScanStatus(badState);
  assert.equal(s2.phase, "unknown");
});

test("getScanStatus 机检铁律:1MB 日志 → logTail ≤ 8192 字节", async () => {
  const bigLog = "x".repeat(1024 * 1024);
  const dir = makeStateDir({ pid: deadPid(), log: bigLog });
  const status = await getScanStatus(dir);
  assert.ok(status.logTail !== undefined, "有日志应返回 logTail");
  assert.ok(Buffer.byteLength(status.logTail!, "utf8") <= 8192, `logTail 应 ≤ 8192 字节,实际 ${Buffer.byteLength(status.logTail!, "utf8")}`);
  assert.ok(status.logTail!.endsWith("x".repeat(100)), "logTail 应取自文件尾部");
});

// —— 用例组 B2:cs 启动目标解析(Windows 垫片;只读,不执行真实 cs) ——

test("parseNpmShimEntry:npm 垫片通用形态解析与 %dp0% 展开", () => {
  // 真实 cs.cmd 的 npm 生成形态(引号包裹 %dp0% 相对 .mjs 入口)
  assert.equal(
    parseNpmShimEntry(
      '@ECHO off\r\nGOTO start\r\nIF EXIST "%dp0%\\node.exe" (\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\some-pkg\\bin\\entry.mjs" %*\r\n',
      "D:\\tools\\nodejs",
    ),
    "D:\\tools\\nodejs\\node_modules\\some-pkg\\bin\\entry.mjs",
  );
  // 派发所述 `node "<入口>" "$@"` 形态(入口含空格)
  assert.equal(
    parseNpmShimEntry('node "C:/tools/my cli/entry.js" "$@"', "D:/x"),
    "C:/tools/my cli/entry.js",
  );
  assert.throws(() => parseNpmShimEntry("no js entry here", "D:/x"), /垫片/);
});

test("resolveCsSpawnTarget:win32 对假 cs fixture 垫片解析出假入口", { skip: !isWin }, () => {
  const target = resolveCsSpawnTarget("win32", `${fixtureBin}${path.delimiter}${process.env.PATH}`);
  assert.equal(target.command, process.execPath);
  assert.equal(target.prefixArgs.length, 1);
  assert.equal(fs.readFileSync(target.prefixArgs[0], "utf8"), FAKE_ENTRY_JS, "解析入口应为假 cs 脚本");
});

test("resolveCsSpawnTarget:win32 对真实 cs.cmd 的只读解析(不执行)", { skip: !isWin }, (t) => {
  let target;
  try {
    target = resolveCsSpawnTarget("win32", process.env.PATH.split(path.delimiter).filter((p) => p !== fixtureBin).join(path.delimiter));
  } catch {
    t.skip("本机 PATH 无真实 cs.cmd");
    return;
  }
  assert.ok(path.isAbsolute(target.prefixArgs[0]), "入口应为绝对路径");
  assert.match(target.prefixArgs[0], /\.(m?)js$/i, "入口应为 .js/.mjs");
  assert.ok(fs.existsSync(target.prefixArgs[0]), `入口文件应存在:${target.prefixArgs[0]}`);
});

test("resolveCsSpawnTarget:posix 直接 spawn cs;两平台 cs 缺失均抛", () => {
  const posixBin = path.join(tmpRoot, "posix-bin");
  fs.mkdirSync(posixBin, { recursive: true });
  fs.writeFileSync(path.join(posixBin, "cs"), "#!/bin/sh\nexit 0\n", "utf8");
  assert.deepEqual(resolveCsSpawnTarget("linux", posixBin), { command: "cs", prefixArgs: [] });
  assert.throws(() => resolveCsSpawnTarget("linux", path.join(tmpRoot, "empty-bin")), /cs CLI/);
  assert.throws(() => resolveCsSpawnTarget("win32", path.join(tmpRoot, "empty-bin")), /cs CLI/);
});
