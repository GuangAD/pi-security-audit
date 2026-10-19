/**
 * extensions/scan-runner.ts — 扫描进程生命周期
 *
 * 唯一触碰扫描进程与产物文件系统的模块。
 * 契约:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/scan-runner.ts」节
 * (含变更记录:产物目录双层结构、ScanStatus.detail)。
 *
 * 密钥红线(AGENTS.md):API key 只经 wiring.env 进入子进程环境变量;
 * 禁止出现在 argv、日志、落盘文件、错误消息——命令面一律以 $ENV 引用呈现。
 *
 * 产物目录双层结构:scanDir 根由本包写 state.json 与 scan.log;
 * cs 对 --output-dir 硬性要求空目录,故指向 <scanDir>/artifacts 空子目录,cs 产物全落其中。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LlmWiring } from "./llm-wiring.ts";

// —— 数据结构(spec「数据结构说明」节) ——

/** 扫描参数(工具入参) */
export interface ScanParams {
  scope:
    | { kind: "diff"; base: string; head?: string }
    | { kind: "workingTree"; base?: string }
    | { kind: "paths"; paths: string[] };
  mode?: "standard" | "deep";
  modelOverride?: string;
}

/** 扫描句柄(startScan 返回值) */
export interface ScanHandle {
  scanDir: string;
  pid: number;
  command: string;
  logPath: string;
  statePath: string;
  startedAt: string;
}

/** 扫描状态(getScanStatus 返回值) */
export interface ScanStatus {
  phase: "running" | "completed" | "failed" | "unknown";
  pidAlive: boolean;
  logTail?: string;
  reportPath?: string;
  detail?: string;
}

/** state.json(与扫描产物同目录,原子写) */
export interface ScanStateFile {
  scanDir: string;
  pid: number;
  commandRedacted: string;
  repoPath: string;
  startedAt: string;
  params: ScanParams;
}

/** 注册表条目:进程 exit 后条目保留(exited 标记),session_shutdown 经 cleanup 只清注册表、不杀进程 */
export interface ScanEntry {
  pid: number;
  scanDir: string;
  child: ChildProcess;
  exited: boolean;
  onExit: () => void;
}

/** 模块级注册表:pid → 条目;并发上限只计未退出条目 */
export const activeScans = new Map<number, ScanEntry>();

/** 数值预算:并发扫描上限(spec 数值预算表) */
export const CONCURRENT_SCAN_LIMIT = 2;

/** 数值预算:status 日志尾部字节上限(8KB) */
const LOG_TAIL_MAX_BYTES = 8192;

// —— cs 命令解析(Windows 垫片直 spawn;POSIX 直接 spawn "cs") ——

/** cs 启动目标:command 为可执行文件,prefixArgs 为其前导参数(Windows 下为解析出的 JS 入口) */
export interface CsSpawnTarget {
  command: string;
  prefixArgs: string[];
}

/** 在 PATH 中查找命令文件,返回第一个可访问的绝对路径;找不到返回 null */
function findOnPath(name: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      /* 下一个 PATH 条目 */
    }
  }
  return null;
}

/**
 * 从 npm 垫片(.cmd)内容解析真实 JS 入口路径。
 * 垫片形态:npm 生成的 `node "<入口>" "$@"` / `"%_prog%"  "%dp0%\...\xxx.(m)js" %*`,
 * 入口为引号包裹的 .js/.mjs 路径且以 %dp0%(垫片所在目录)为基准;解析对任意垫片通用,不硬编码包名。
 * 抛错:内容中找不到引号包裹的 .js/.mjs 入口。
 */
export function parseNpmShimEntry(content: string, shimDir: string): string {
  const match = content.match(/"([^"]+\.(?:js|mjs))"/i);
  if (!match) throw new Error("cs.cmd 垫片解析失败:未在其中找到引号包裹的 .js/.mjs 入口路径。");
  return match[1].replace(/%dp0%/gi, shimDir);
}

/**
 * 解析 cs 启动目标(预检与 spawn 共用)。
 * win32:PATH 上找 cs.cmd → 读垫片内容解析真实 JS 入口 → 返回 process.execPath + [入口](shell:false,argv 保真);
 * 其他平台:PATH 上确认 cs 存在后直接 spawn "cs"(libuv 负责 PATH 解析)。
 * 抛错:cs 不在 PATH / 垫片不可解析(消息可读,不含密钥)。
 */
export function resolveCsSpawnTarget(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string | undefined = process.env.PATH,
): CsSpawnTarget {
  if (platform === "win32") {
    const shimPath = findOnPath("cs.cmd", pathEnv);
    if (!shimPath) {
      throw new Error("cs CLI 不在 PATH(未找到 cs.cmd):请安装 codex-security(npm 全局包)并确保 cs 命令可用。");
    }
    const entry = parseNpmShimEntry(fs.readFileSync(shimPath, "utf8"), path.dirname(shimPath));
    return { command: process.execPath, prefixArgs: [entry] };
  }
  if (!findOnPath("cs", pathEnv)) {
    throw new Error("cs CLI 不在 PATH:请安装 codex-security(npm 全局包)并确保 cs 命令可用。");
  }
  return { command: "cs", prefixArgs: [] };
}

// —— 产物目录(变更记录:双层结构;CODEX_HOME → ~/.codex 回退) ——

/**
 * 构造扫描子进程环境:注入 wiring env;占位 OPENAI_API_KEY 满足 cs --auth api-key 预检
 * (真实鉴权走 wiring.env 的 env_key,占位值不参与任何请求);
 * win32 重定向 TEMP/TMP 至权限收敛目录(无 Users 组写权限),解除 cs 内嵌 Codex 的
 * 凭证临时目录 ACL 校验拦截(用户 profile 目录实测可通过)。
 */
export function buildChildEnv(wiringEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ...wiringEnv } as Record<string, string>;
  if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
    env.OPENAI_API_KEY = "pi-codex-security-placeholder";
  }
  if (process.platform === "win32") {
    const credTemp = path.join(resolveCsStateDir(), "tmp-cred");
    fs.mkdirSync(credTemp, { recursive: true });
    env.TEMP = credTemp;
    env.TMP = credTemp;
  }
  return env;
}

/** cs state 根目录:环境变量 CODEX_HOME,未设回退 ~/.codex */
function resolveCsStateDir(): string {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".codex");
}

/** repoName 安全化:替换文件系统非法字符;空名兜底 "_" */
function sanitizeRepoName(repoPath: string): string {
  const base = path.basename(repoPath).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return base || "_";
}

/** 时间戳 yyyyMMddHHmmss(本地时区) */
function timestampStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 创建唯一 scanDir:<csState>/plugins/codex-security/scans/<repoName>/<时间戳>-<pid>,
 * 同秒同 pid 碰撞依次加 -1、-2 … 后缀;只建 scanDir 根,artifacts/ 由调用方补建。
 */
function createScanDir(repoPath: string): string {
  const base = path.join(resolveCsStateDir(), "plugins", "codex-security", "scans", sanitizeRepoName(repoPath));
  const stem = `${timestampStamp()}-${process.pid}`;
  let candidate = path.join(base, stem);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(base, `${stem}-${i}`);
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

// —— 参数校验与 args 拼装(cs --help 实测参数表) ——

/** scope 校验:diff.base/head、workingTree.base(若给)须非空串;paths 须非空数组且逐项非空串 */
function validateScope(scope: ScanParams["scope"]): void {
  switch (scope.kind) {
    case "diff": {
      if (typeof scope.base !== "string" || !scope.base.trim()) {
        throw new Error("非法扫描参数:diff 范围的 base 必须为非空字符串(如 origin/main)。");
      }
      if (scope.head !== undefined && (typeof scope.head !== "string" || !scope.head.trim())) {
        throw new Error("非法扫描参数:diff 范围的 head 若提供必须为非空字符串。");
      }
      return;
    }
    case "workingTree": {
      if (scope.base !== undefined && (typeof scope.base !== "string" || !scope.base.trim())) {
        throw new Error("非法扫描参数:workingTree 范围的 base 若提供必须为非空字符串(如 HEAD)。");
      }
      return;
    }
    case "paths": {
      if (!Array.isArray(scope.paths) || scope.paths.length === 0) {
        throw new Error("非法扫描参数:paths 范围必须提供至少一个路径。");
      }
      if (scope.paths.some((p) => typeof p !== "string" || !p.trim())) {
        throw new Error("非法扫描参数:paths 范围的每一项必须为非空字符串。");
      }
      return;
    }
    default:
      throw new Error(`非法扫描参数:未知 scope kind。`);
  }
}

function validateScanParams(params: ScanParams): void {
  validateScope(params.scope);
  if (params.mode !== undefined && params.mode !== "standard" && params.mode !== "deep") {
    throw new Error("非法扫描参数:mode 只能为 standard 或 deep。");
  }
}

/** scope → cs 参数段:--diff <ref>[--head <ref>] / --working-tree[--base <ref>] / 重复 --path <path> */
function buildScopeArgs(scope: ScanParams["scope"]): string[] {
  switch (scope.kind) {
    case "diff":
      return scope.head !== undefined ? ["--diff", scope.base, "--head", scope.head] : ["--diff", scope.base];
    case "workingTree":
      return scope.base !== undefined ? ["--working-tree", "--base", scope.base] : ["--working-tree"];
    case "paths":
      return scope.paths.flatMap((p) => ["--path", p]);
  }
}

/** 完整 argv(不含可执行文件与前导参数):scan 子命令 + scope + mode + headless + 产物目录 + codex 注入 + 模型 */
export function buildScanArgs(params: ScanParams, wiring: LlmWiring, artifactsDir: string): string[] {
  const args = ["scan", ".", ...buildScopeArgs(params.scope)];
  if (params.mode !== undefined) args.push("--mode", params.mode);
  // --auth api-key:cs 默认 auto 只认 ChatGPT 登录或 OPENAI/CODEX_API_KEY,不认自定义 provider 注入;
  // 真实鉴权走 wiring.env 的 env_key,此处仅为满足 cs 自身 auth 预检(占位 OPENAI_API_KEY 见 buildChildEnv)。
  args.push("--headless", "--auth", "api-key", "--output-dir", artifactsDir);
  for (const codexArg of wiring.codexArgs) args.push("--codex", codexArg);
  args.push("--model", wiring.model);
  return args;
}

// —— 命令行脱敏渲染(shell 风格引号;env 值替换为 $NAME;env 前缀 NAME=$NAME) ——

/** shell 风格引号:含空白/引号/反斜杠的词元加双引号,内部仅转义 \" 与 \\ */
function shellQuote(token: string): string {
  if (!/[\s"\\]/.test(token)) return token;
  let out = '"';
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "\\" && (token[i + 1] === '"' || token[i + 1] === "\\")) {
      out += c + c;
      i++;
      continue;
    }
    out += c === '"' ? '\\"' : c;
  }
  return out + '"';
}

function joinShellLike(tokens: string[]): string {
  return tokens.map(shellQuote).join(" ");
}

/**
 * 渲染脱敏命令行:每项 env 以 `NAME=$NAME ` 前缀呈现(值绝不入命令面),
 * 且正文若意外出现 env 值明文则替换为 $NAME(密钥红线双保险)。
 */
function renderRedactedCommand(target: CsSpawnTarget, args: string[], env: Record<string, string>): string {
  let body = joinShellLike([target.command, ...target.prefixArgs, ...args]);
  for (const [name, value] of Object.entries(env)) {
    if (value) body = body.split(value).join(`$${name}`);
  }
  const prefix = Object.keys(env)
    .map((name) => `${name}=$${name}`)
    .join(" ");
  return prefix ? `${prefix} ${body}` : body;
}

/** state.json 原子写:临时文件 + rename */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

// —— pid 存活探测 ——

/** process.kill(pid, 0):成功或 EPERM(存在但无权信号)→ 活;ESRCH → 死 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读日志尾部至多 8192 字节;文件缺失/不可读返回 undefined */
function readTailText(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL_MAX_BYTES);
    if (len <= 0) return undefined;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// —— seam:startScan ——

/**
 * 预检(参数合法 → git 仓库 → 并发上限 → cs 可解析)后后台 spawn cs scan,立即返回句柄。
 * 预检失败一律不 mkdir(无半初始化产物目录);spawn 同步失败清理已建目录后抛出。
 * 子进程 detached + unref(不阻塞宿主退出),stdout/stderr 合并落 <scanDir>/scan.log;
 * exit 只登记模块级注册表,不杀进程。
 */
export async function startScan(params: ScanParams, wiring: LlmWiring, repoPath: string): Promise<ScanHandle> {
  validateScanParams(params);

  const repoRoot = path.resolve(repoPath);
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    throw new Error(`repoPath 不是 git 仓库(未找到 .git):${repoRoot}。请在 git 仓库目录内发起扫描。`);
  }

  let activeCount = 0;
  for (const entry of activeScans.values()) if (!entry.exited) activeCount++;
  if (activeCount >= CONCURRENT_SCAN_LIMIT) {
    throw new Error("concurrent-scan-limit");
  }

  const target = resolveCsSpawnTarget();

  // 双层产物目录:scanDir 根落 state.json 与日志;空 artifacts/ 经 --output-dir 传给 cs
  const scanDir = createScanDir(repoRoot);
  const artifactsDir = path.join(scanDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const logPath = path.join(scanDir, "scan.log");
  const statePath = path.join(scanDir, "state.json");

  const args = buildScanArgs(params, wiring, artifactsDir);
  const startedAt = new Date().toISOString();
  const commandRedacted = renderRedactedCommand(target, args, wiring.env);

  // 日志直传 fd:子进程 stdio 直写日志文件,不经父进程管道——pi 会话退出后管道读端关闭
  // 会致 detached cs EPIPE 崩溃或日志截断,威胁跨会话存活契约(评审 Important 修复)
  const logFd = fs.openSync(logPath, "w");
  let child: ChildProcess;
  try {
    child = spawn(target.command, [...target.prefixArgs, ...args], {
      detached: true,
      cwd: repoRoot,
      env: buildChildEnv(wiring.env),
      stdio: ["ignore", logFd, logFd],
    });
  } catch (err) {
    fs.closeSync(logFd);
    fs.rmSync(scanDir, { recursive: true, force: true });
    throw err;
  }
  if (child.pid === undefined) {
    child.on("error", () => {
      /* 启动失败已按错误抛出,吞掉后续 error 事件避免未处理异常 */
    });
    fs.closeSync(logFd);
    fs.rmSync(scanDir, { recursive: true, force: true });
    throw new Error("cs 进程启动失败:未能获得子进程 pid。");
  }
  fs.closeSync(logFd);
  child.on("error", (err) => {
    fs.appendFileSync(logPath, `\n[scan-runner] cs 进程启动失败:${err.message}\n`);
  });
  child.unref();

  const pid = child.pid;
  const state: ScanStateFile = { scanDir, pid, commandRedacted, repoPath: repoRoot, startedAt, params };
  writeJsonAtomic(statePath, state);

  const entry: ScanEntry = {
    pid,
    scanDir,
    child,
    exited: false,
    onExit: () => {
      entry.exited = true;
    },
  };
  child.on("exit", entry.onExit);
  activeScans.set(pid, entry);

  return { scanDir, pid, command: commandRedacted, logPath, statePath, startedAt };
}

// —— seam:getScanStatus ——

/**
 * 凭产物目录查询扫描状态,不依赖内存注册表(会话重启后凭 state.json 恢复)。
 * phase 唯一决定:state.json 缺失/不可解析 → unknown;pid 活 → running;
 * pid 死且 <scanDir>/artifacts/report.md 在 → completed;pid 死且不在 → failed。只读,不抛。
 */
export async function getScanStatus(scanDir: string): Promise<ScanStatus> {
  const dir = path.resolve(scanDir);
  let dirStat: fs.Stats | null = null;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    dirStat = null;
  }
  if (!dirStat?.isDirectory()) {
    return { phase: "unknown", pidAlive: false, detail: `scanDir 不存在:${dir}` };
  }

  const statePath = path.join(dir, "state.json");
  let state: ScanStateFile;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8")) as ScanStateFile;
  } catch {
    return { phase: "unknown", pidAlive: false, detail: `state.json 缺失或不可解析:${statePath}` };
  }
  if (typeof state?.pid !== "number") {
    return { phase: "unknown", pidAlive: false, detail: `state.json 内容不合法(缺 pid 字段):${statePath}` };
  }

  const pidAlive = isPidAlive(state.pid);
  const logTail = readTailText(path.join(dir, "scan.log"));
  const reportPath = path.join(dir, "artifacts", "report.md");
  const tailField = logTail !== undefined ? { logTail } : {};

  if (pidAlive) {
    return { phase: "running", pidAlive: true, ...tailField };
  }
  if (fs.existsSync(reportPath)) {
    return { phase: "completed", pidAlive: false, reportPath, ...tailField };
  }
  return {
    phase: "failed",
    pidAlive: false,
    ...tailField,
    detail: "扫描进程已退出但未生成 report.md,详见日志尾部。",
  };
}

// —— session_shutdown 资源清理 ——

/**
 * 解除全部注册表引用与 exit 监听,不杀扫描进程(design 决策:detached 放它跑完)。
 * pi session_shutdown 与测试 teardown 调用。
 */
export function cleanup(): void {
  for (const entry of activeScans.values()) {
    entry.child.removeListener("exit", entry.onExit);
  }
  activeScans.clear();
}
