# pi-codex-security 包实现规格(spec)

> 日期:2026-10-16 | 状态:骨架已批准(门 1,2026-10-16;门 2 用例详版批准后改为:已批准)
> 设计依据:./design.md(已批准)
> 流程:dev 重流程阶段 1 起草骨架,阶段 2 补全用例详版
>
> 与 design.md 的分工:design.md 是决策快照,门 1 批准后冻结;本文件是实现契约,随开发演进——任何修订必须登记到文末「变更记录」。两者冲突时以 design.md 为准;修订触及 design.md 决策时走回退协议,禁止就地改本文件了事。

## 数据结构说明

```typescript
/** LLM 接线结果:传给 cs scan 的注入参数与子进程环境变量 */
interface LlmWiring {
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
interface LlmWiringError {
  reason: "protocol-unsupported" | "no-credential" | "cs-missing";
  provider?: string;
  detail: string;
}

/** 扫描参数(工具入参,TypeBox schema 的静态类型) */
interface ScanParams {
  scope:
    | { kind: "diff"; base: string; head?: string }   // 默认 base="origin/main"
    | { kind: "workingTree"; base?: string }           // 默认 base="HEAD"
    | { kind: "paths"; paths: string[] };
  mode?: "standard" | "deep";                          // 默认 standard
  modelOverride?: string;                              // 覆盖会话模型 id(端点仍按 provider 解析)
}

/** 扫描句柄(scan 工具返回值核心字段) */
interface ScanHandle {
  scanDir: string;      // cs 产物目录绝对路径
  pid: number;
  command: string;      // 完整命令行(key 已脱敏为 $ENV 引用)
  logPath: string;      // stdout/stderr 合并日志
  statePath: string;    // state.json 路径
  startedAt: string;    // ISO 8601
}

/** 扫描状态(status 工具返回值核心字段) */
interface ScanStatus {
  phase: "running" | "completed" | "failed" | "unknown";
  pidAlive: boolean;
  logTail?: string;           // ≤ 8KB
  reportPath?: string;        // report.md 绝对路径(completed 时)
  summary?: FindingSummary;   // completed 且解析成功时
}

/** findings 摘要 */
interface FindingSummary {
  counts: Record<"critical" | "high" | "medium" | "low", number>;
  topFindings: Array<{ severity: string; location: string; evidence: string; confidence?: string }>; // ≤ 10 条,severity 降序
  source: "findings-json" | "report-md";
}

/** state.json(与扫描产物同目录,原子写) */
interface ScanStateFile {
  scanDir: string;
  pid: number;
  commandRedacted: string;
  repoPath: string;
  startedAt: string;
  params: ScanParams;
}

/** 扫描专用覆盖配置 <agent-dir>/codex-security.json(可选文件,缺省不报错;agent-dir 解析见约束节) */
interface CsOverrideConfig {
  baseUrl: string;      // Responses 协议端点
  model: string;        // 扫描模型 id
  apiKeyEnv?: string;   // 凭证环境变量名,默认 "ZAI_API_KEY"
  providerName?: string; // cs 内 provider 名,默认 "PI_OVERRIDE"
}
```

约束:

- `FindingSummary.counts` 四个键必须齐备,无该级别发现时为 0。
- `ScanHandle.command` 与 `ScanStateFile.commandRedacted` 中不得出现任何密钥明文(红线,机检见数值预算)。
- 覆盖配置文件缺失、字段不全时视为「无覆盖」,不视为错误。
- **agent-dir 解析(贯穿全部 pi 配置读取)**:先取环境变量 `PI_CODING_AGENT_DIR`,未设则回退 `~/.pi/agent`;auth.json、models.json、覆盖配置三处读取一律经该解析,禁止写死路径。依据:pi configuration.md「Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's `agentDir` option」。

## seam 接口规格

### extensions/llm-wiring.ts

唯一知道 pi 配置格式与协议映射的模块;输出 cs 注入参数与环境变量。

#### resolveLlmWiring(sessionModel, overrides)

`resolveLlmWiring(sessionModel: SessionModelInfo | null, overrides: CsOverrideConfig | null): LlmWiring | LlmWiringError` —— 把会话当前模型(或覆盖配置)解析为 cs 的 provider 注入。

**组合边界型 seam**:行为由「协议(responses/chat/其他)× 凭证(auth.json/models.json/env/无)× 来源(会话/覆盖配置)」多维组合决定,门 2 前必须补等价类矩阵 + 枚举范围覆盖声明,组合积不得只靠用例表。

- **后置条件**:
  - 返回 `LlmWiring` 时:`codexArgs` 恰含 `model_provider`、`model_providers.<N>.base_url`、`model_providers.<N>.wire_api="responses"`、`model_providers.<N>.env_key` 五类键;`env` 恰含一个键,值为明文 key;key 不出现在 `codexArgs` 任何元素中。
  - Responses 协议模型(`api` 含 `responses`):`base_url` 等于模型自身 `baseUrl`,不查映射表。
  - Chat 协议模型(`api === "openai-completions"`):按映射表把已知 provider 的 baseUrl 换为对应 Responses 端点(首期仅智谱系:`open.bigmodel.cn/api/coding/paas/v4` → `open.bigmodel.cn/api/v1`);无映射条目 → `LlmWiringError("protocol-unsupported")`。
  - 其他协议(`anthropic-messages` 等):一律 `LlmWiringError("protocol-unsupported")`,不做任何回退。
  - 凭证解析顺序:pi auth.json → pi models.json 内联 apiKey → 环境变量(前两者路径经 agent-dir 解析,见约束节);三者皆无 → `LlmWiringError("no-credential")`。
- **副作用与可重入性**:纯函数,无状态,重复调用结果一致(同输入)。
- **错误行为**:输入模型为 `null` 且无覆盖配置 → 返回 `LlmWiringError`(不抛异常);映射表命中判断失败一律返回错误对象,永不静默换 provider。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 智谱 chat 协议映射 | provider `zai-coding-cn`,api `openai-completions`,baseUrl `https://open.bigmodel.cn/api/coding/paas/v4`,model `glm-5.3-flash`,key 可得 | codexArgs 含 `model_providers.N.base_url="https://open.bigmodel.cn/api/v1"` 与 `wire_api="responses"`;env 含明文 key;model 原样透传 | 智谱官方文档 docs.bigmodel.cn(Codex 专用 Responses 端点) |
  | Responses 协议直连 | api `openai-responses`,baseUrl `https://api.deepseek.com` | base_url 等于该 baseUrl,映射表未参与 | pi models.json 实测配置 |
  | 不兼容协议显式报错 | api `anthropic-messages`,无覆盖配置 | `LlmWiringError("protocol-unsupported")`,detail 含 provider 名 | cs 内嵌 Codex 0.162.1 仅支持 Responses 协议 |
  | 无凭证报错 | 三级凭证来源皆空 | `LlmWiringError("no-credential")`,detail 含补救指引 | design.md 权衡节 |

#### loadOverrides()

`loadOverrides(path?: string): CsOverrideConfig | null` —— 读 `<agent-dir>/codex-security.json`,缺文件返回 null;path 缺省时按约束节规则解析 agent-dir。

- **后置条件**:返回对象时 `baseUrl` 与 `model` 非空串;JSON 解析失败或字段缺失 → 返回 null(容忍,不抛)。
- **副作用与可重入性**:只读文件系统;重复调用一致。
- **错误行为**:文件存在但非法 → 静默视为无覆盖,由调用方决定是否提示。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 缺文件 | 不存在的路径 | null,不抛 | design 决策 #2「没有则报错」指接线失败,非配置缺失 |

### extensions/scan-runner.ts

唯一触碰扫描进程与产物文件系统的模块。

#### startScan(params, wiring, repoPath)

`startScan(params: ScanParams, wiring: LlmWiring, repoPath: string): Promise<ScanHandle>` —— 预检后后台 spawn `cs scan`,立即返回句柄。

- **后置条件**:
  - 返回时子进程已启动(或 spawn 同步失败已抛出);`scanDir`、`statePath`、`logPath` 均为已存在的绝对路径。
  - `state.json` 已原子写入,`commandRedacted` 中环境变量引用形如 `$ZAI_CS_KEY`。
  - spawn 参数含 `--headless` 与 wiring 的全部 `--codex` 参数;不携带 `--output-dir`。
- **副作用与可重入性**:每调用创建一个新产物目录与新进程;活动扫描数达上限 2 时拒绝并抛 `Error("concurrent-scan-limit")`。进程 exit 回调登记在模块级注册表,`session_shutdown` 只解除注册表引用、不杀进程。
- **错误行为**:`repoPath` 非 git 仓库、cs 不在 PATH、scope 非法(base 空串等)→ 抛 `Error`,错误消息可读且不含密钥;不产生半初始化产物目录。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 非法 scope 即失败 | `{ kind: "diff", base: "" }` | 抛错,`cs` 未被 spawn(以注册表计数为证) | 参数校验规格 |
  | 句柄命令脱敏 | 正常 diff 扫描 | `handle.command` 匹配 `/\$\w+/` 且不匹配明文 key | 数据结构约束(密钥红线) |

#### getScanStatus(scanDir)

`getScanStatus(scanDir: string): Promise<ScanStatus>` —— 凭产物目录查询扫描状态,不依赖内存注册表(支持会话重启后查询)。

- **后置条件**:`state.json` 存在时,`phase` 由「pid 存活探测 + report.md 存在性」唯一决定:pid 活 → running;pid 死且 report.md 在 → completed;pid 死且 report.md 不在 → failed;`state.json` 缺失 → unknown。`logTail` 不超过 8KB。
- **副作用与可重入性**:只读;重复调用一致(进程状态变化除外)。
- **错误行为**:目录不存在 → 返回 `unknown` 并带 detail,不抛。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 重启恢复查询 | state.json 存在、pid 为不存活值、report.md 在 | phase `completed`,返回 reportPath | design「后台+通知」权衡节的跨会话边界 |

### extensions/findings-parser.ts

唯一解析扫描产物的模块;失败降级,不报假状态。

#### summarizeFindings(scanDir)

`summarizeFindings(scanDir: string): Promise<FindingSummary | { degraded: true; reportPath: string | null }>` —— 产出严重级别摘要。

- **后置条件**:`counts` 四级别齐备;`topFindings` 按 severity 降序、至多 10 条;`source` 标明数据来源。
- **副作用与可重入性**:优先调用 `cs findings --json`(与产物同源),失败时手解析 findings.json,再失败降级 report.md;无写操作。
- **错误行为**:三种来源全缺 → 返回 degraded 对象,不抛;JSON 字段缺失按 0/空处理,不臆造。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 计数精确 | 静态 fixture:critical 1、high 2、medium 3、low 0 | counts 逐级相等,source `findings-json` | 构造 fixture(非同算法重算) |
  | 降级不抛 | 仅 report.md 存在 | `{ degraded: true, reportPath: <非null> }` | design「findings 解析降级」决策 |

### extensions/index.ts(pi 工具)

装配层;三个工具的 execute 是模型可调的顶层 seam,行为组合上述模块。

#### codex_security_scan.execute

- **后置条件**:成功返回 ScanHandle 全字段(structuredContent);接线失败返回 `isError` 结果,detail 含补救指引(/model 切换或写覆盖配置);并发超限返回 isError。
- **副作用与可重入性**:每次调用至多启动一个扫描进程;不修改 plan/spec 文档以外的任何仓库文件。
- **错误行为**:所有失败以 isError 结果返回,不向模型抛裸异常;错误 reason 与下游模块错误一一映射,不吞不改写。
- **pinned case**(工具层独立逻辑 = 错误映射;组合行为由下游 seam 用例 + Gate B 集成覆盖):

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | 并发超限错误映射 | 已有 2 个活动扫描时第 3 次调用 | isError,detail 含 `concurrent-scan-limit`,无新进程 | startScan 上限规格 |
  | 接线失败错误映射 | 会话模型为 anthropic 协议、无覆盖配置 | isError,detail 含「/model 切换」与「覆盖配置」两个补救指引 | resolveLlmWiring 错误规格 |

#### codex_security_status.execute

- **后置条件**:completed 时同时返回 reportPath 与 summary;failed 时返回 logTail;unknown 时带 detail。全部字段经 structuredContent 返回。
- **副作用与可重入性**:只读。
- **错误行为**:scanDir 参数非法 → isError。
- **pinned case**:同上,组合行为,Gate B 覆盖。

#### codex_security_run.execute

- **后置条件**:`command` ∈ cs 子命令白名单(全部子命令,排除 `login`/`logout`/`mcp`);stdout+stderr 合并输出,超过 50KB 截断并附截断标记;退出码透传。
- **副作用与可重入性**:前台执行,继承当前 cwd;无内部状态。
- **错误行为**:`login`/`logout` → isError,提示终端执行;`mcp` → isError,提示官方排除扫描走 MCP;未知命令 → isError 并附合法命令清单;超时(默认 600s,参数上限 3600s)→ 杀进程树 + isError。
- **pinned case**:

  | 用例 | 输入 | 期望 | 事实源 |
  |---|---|---|---|
  | info 透传 | `command: "info"` | exit 0,stdout 含 `sdkVersion` | cs info 实测输出 |
  | login 拒绝 | `command: "login"` | isError,detail 含「终端执行」指引 | design 非目标 #1 |

#### /security-scan 命令

- **行为**:薄封装,把参数解析为 ScanParams 后调 scan 工具 execute,结果经 ui.notify 呈现;无独立状态。
- **pinned case**:无——等价于工具调用,Gate B 覆盖。

## 接口面穷举清单

- `extensions/index.ts.default` — 非 seam — 扩展工厂,注册全部工具与命令;无状态,重复加载由 pi 运行时管理。
- `extensions/index.ts` 工具名 `codex_security_scan` — seam — 行为见「codex_security_scan.execute」。
- `extensions/index.ts` 工具名 `codex_security_status` — seam — 行为见「codex_security_status.execute」。
- `extensions/index.ts` 工具名 `codex_security_run` — seam — 行为见「codex_security_run.execute」。
- `extensions/index.ts` 命令名 `security-scan` — 非 seam — 薄封装,等价工具调用。
- `extensions/llm-wiring.ts.resolveLlmWiring` — seam。
- `extensions/llm-wiring.ts.loadOverrides` — seam。
- `extensions/llm-wiring.ts.PROTOCOL_ENDPOINT_MAP` — 非 seam — 模块级只读常量;重用语义:不可变,无清空/累加问题。
- `extensions/scan-runner.ts.startScan` — seam。
- `extensions/scan-runner.ts.getScanStatus` — seam。
- `extensions/scan-runner.ts.activeScans` — 非 seam — 模块级 Map;重用语义:扫描进程 exit 后条目保留至 status 确认终态,新会话加载时清空(以 state.json 为准恢复,不迁移)。
- `extensions/findings-parser.ts.summarizeFindings` — seam。
- `package.json` `pi` 清单声明 — 非 seam — 声明 extensions/skills 目录,无逻辑。

## 非 seam 模块与视觉验收

- `skills/codex-security-scan/SKILL.md`:目测验收,逐条:
  - 含自然语言触发词节(扫描/安全审查/security scan 等变体)。
  - 命令参考表覆盖 cs 全部子命令(以 `cs --help` 输出为对照清单),每命令一行用途 + 关键参数。
  - 三级执行纪律:patch/verify-fix 确认后执行;publish/--create-pr/feedback 仅用户明确要求;login/logout 指引终端。
  - 官方 skills 提醒规则:场景超出指引时建议 `cs skills add`。
  - 跨会话边界说明:完成通知依赖会话存活,重启后主动 status。
  - 解读纪律:按严重级别只读汇报,以 report.md 为准。
- `package.json`:机检——`pi -e ./` 加载无报错、`pi install ./` 后 `pi list` 可见(集成验证命令,Gate B 执行)。

### 数值预算(逐条机检)

| 预算 | 值 | 机检方案 |
|---|---|---|
| run 输出截断 | 50KB,附截断标记 | 单测:构造超长 stdout 的假进程,断言输出长度与标记存在 |
| run 超时 | 默认 600s,参数上限 3600s | 单测:毫秒级超时参数传入,断言进程被杀且 isError |
| 并发扫描上限 | 2 | 单测:第 3 次 startScan 断言抛 `concurrent-scan-limit` |
| status 日志尾部 | ≤ 8KB | 单测:构造 1MB 日志文件,断言返回长度 |
| topFindings 条数 | ≤ 10,severity 降序 | fixture 单测断言 |
| 密钥脱敏 | command/state/log/错误消息零明文 key | 单测:全产物文本扫描断言不含 key 值 |

### 门 3 用户目测清单

- 任一 git 项目自然语言触发扫描 → 后台启动 → 完成通知 → 解读汇报符合纪律。
- `/security-scan` 命令可用。
- /model 切换模型后再次扫描,模型跟随(status 或日志可见模型 id)。
- 不兼容模型触发时收到可读报错与切换指引。

## 编码方向

### extensions/llm-wiring.ts

1. 凭证解析按 auth.json → models.json → env 顺序,读到即止;路径统一经 `resolveAgentDir()` 帮助函数(`PI_CODING_AGENT_DIR` → `~/.pi/agent` 回退),任何模块不得硬编码 `~/.pi/agent`。
2. TOML 值构造统一走一个 `tomlValue()` 帮助函数:双引号包裹、内部双引号转义,禁止手工拼字符串。
3. 映射表以 baseUrl 主机名为键,精确匹配,不做后缀猜测。

### extensions/scan-runner.ts

1. `spawn(csPath, args, { detached: true, cwd: repoPath, env: {...process.env, ...wiring.env} })`,`stdio` 三流落日志文件,`child.unref()` 后保留引用注册 exit 监听。
2. `state.json` 原子写:临时文件 + rename。
3. `session_shutdown` 只清注册表与监听,不杀进程(design 决策)。
4. pid 存活探测:`process.kill(pid, 0)` 捕获 ESRCH/EPERM 区分。

### extensions/findings-parser.ts

1. 解析优先级:`cs findings --json` → 手解析 findings.json → report.md 降级。
2. 手解析仅做字段提取与计数,不做任何推理或去重(那是 cs 的事)。

### 已知的坑

- cs `--output-dir` 官方强制仓库外:不传该参数,使用默认 state dir。
- GLM 对 Codex effort 档位(默认 xhigh)的兼容性未实测:Gate A 用 `--dry-run`/`--mock` 验证,失败降档固化进 wiring。
- `auth.json`/`models.json` 是 pi 内部格式:读取逻辑集中在 llm-wiring,读不到降级 `ZAI_API_KEY`。
- Windows 下 `detached` 与 PATH 解析:cs 的 `.cmd` 垫片需 `shell: true` 或解析真实入口,实现时以 Gate B 实测为准。
- `--diff` 依赖 git 仓库:startScan 预检 `.git` 存在性,失败给可读错误。

## 变更记录

- 无
