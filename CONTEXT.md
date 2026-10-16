# CONTEXT.md — 领域词汇表

纯词汇表:每条回答「这个词在本项目中指什么」。零实现细节,实现契约见 docs/plans/。

## cs / codex-security

OpenAI 的代码安全扫描 CLI(npm 包 `codex-security`,本机 0.3.0),内嵌 Codex 0.162.1 作为推理引擎。本项目所有扫描能力的事实来源,PATH 中命令名 `cs`。

反义/易混淆:cs ≠ Codex CLI 本体;cs 的扫描引擎是内嵌 Codex,但凭证、模型、端点由本包经 `--codex` 参数注入,与用户终端里的 Codex CLI 配置互不影响。

## 扫描引擎 LLM 接线(llm-wiring)

把「pi 会话当前模型 + 凭证」转换为 cs 扫描子进程可用的 provider 注入参数(`--codex` TOML 串)与环境变量的过程。唯一发生在 `extensions/llm-wiring.ts`。

反义/易混淆:「扫描模型」指 cs 用的模型(跟随 /model),「会话模型」指 pi 对话用的模型——两者通常是同一个,但 scan 工具的 `modelOverride` 可临时分离。

## Responses 端点映射

Chat Completions 协议端点 → OpenAI Responses 协议端点的固定转换表。首期唯一条目:智谱 `open.bigmodel.cn/api/coding/paas/v4` → `open.bigmodel.cn/api/v1`。存在原因:cs 内嵌 Codex 只认 Responses 协议(Codex 0.162.1 移除 chat wire)。

## 扫描专用覆盖配置

`<agent-dir>/codex-security.json`(agent-dir 由 `PI_CODING_AGENT_DIR` 决定,默认 `~/.pi/agent`),用户手工写的扫描模型/端点/凭证来源声明。生效条件:会话模型协议不兼容时才读取;它也没有 → 接线报错(不静默换模型)。

## 会话模型跟随

扫描引擎动态读取 `pi.getModel()` 的行为;/model 切换后下一次扫描即用新模型。协议不兼容是该语义的唯一边界。

## 透传(run)

`codex_security_run` 工具把 cs 子命令原样转发执行的行为:前台运行、输出截断、退出码透传,不二次加工语义。白名单含 cs 全部子命令,仅排除 `login`/`logout`(凭证走 pi 路线,无需登录)与 `mcp`(官方排除扫描走 MCP)。

## 强纪律命令

允许经工具调用、但 skill 写死「仅用户在对话中明确要求/确认后才执行」的命令:`patch`、`verify-fix`、`--patch`(改代码,确认后执行)、`publish`、`--create-pr`、`feedback`(写外部系统,仅明确要求)。

## 扫描句柄(scanDir)

scan 工具返回的产物目录绝对路径,后续 status 查询的唯一凭据。与扫描进程 pid 一起落盘在产物目录的 `state.json`,pi 会话重启后仍可凭它恢复查询。

## Gate A / B / C

三个验证关口:A = LLM 接线实测(--dry-run/--mock 无成本验证 GLM 兼容性,固化命令模板);B = 包集成验证(pi 加载扩展、工具全链路);C = 自然语言路由与汇报纪律验证。
