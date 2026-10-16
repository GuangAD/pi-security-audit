# AGENTS.md — pi-codex-security

## 项目定位

pi 包:在 pi agent 中全功能调用 codex-security CLI(cs),自然语言或 `/security-scan` 触发安全扫描;扫描引擎 LLM 自动接线(跟随会话模型),凭证零手工配置。以 `pi install` 安装交付。

## 核心目录及职责

- `extensions/index.ts` — 装配:注册 3 工具(scan/status/run)+ `/security-scan` 命令 + 完成通知。
- `extensions/llm-wiring.ts` — 会话模型 → cs provider 注入参数与环境变量;唯一知道 pi 配置格式与协议映射的模块。
- `extensions/scan-runner.ts` — 扫描进程生命周期:spawn/注册表/pid 落盘/状态查询;唯一触碰扫描进程与产物文件系统。
- `extensions/findings-parser.ts` — 扫描产物 → 严重级别摘要;解析失败降级,不报假状态。
- `skills/codex-security-scan/SKILL.md` — 触发路由 + 全命令参考 + 分级安全纪律。
- `docs/plans/<日期>-<slug>/` — 设计文档(design/spec/plan);`docs/adr/` — 决策记录;`CONTEXT.md` — 领域词汇表。

## 工作流导航

dev 重流程(heavy track)进行中:门 1 已批准(2026-10-16),当前处于阶段 2(用例详版 + plan.md)。恢复中断用 `/dev-resume`,先重读 design.md、spec.md(含变更记录)与 plan.md。

## 文档指针

- 决策快照:`docs/plans/2026-10-16-pi-codex-security/design.md`(冻结,改动走回退协议)
- 实现契约:`docs/plans/2026-10-16-pi-codex-security/spec.md`(演进须登记变更记录)
- 难逆转决策:ADR-0001(LLM 跟随会话模型)、ADR-0002(专项 + 透传全覆盖架构)
- 术语:CONTEXT.md

## 工程边界

- TypeScript 由 pi 的 jiti 直跑:不设编译、不设 build 脚本。
- 零第三方 npm 依赖:进程 `node:child_process`、文件 `node:fs`、schema 用宿主 typebox;宿主包只进 peerDependencies(range `*`)。
- 外部依赖:cs CLI ≥ 0.3.0 在 PATH;缺失报可读错误,不代装。
- **agent-dir 动态解析**:auth.json / models.json / 覆盖配置一律经 `resolveAgentDir()`(`PI_CODING_AGENT_DIR` → `~/.pi/agent` 回退),禁止硬编码路径。
- **密钥红线**:API key 只经子进程环境变量传递;禁止出现在命令行参数、日志、落盘文件、错误消息。
- 扫描产物用 cs 默认 state dir,不传 `--output-dir`(官方强制仓库外)。
- 测试用 node:test 内置框架(零依赖),测试文件放 `extensions/*.test.ts`。

## 执行纪律

- 不静默换模型:接线失败显式报错(ADR-0001),永不自动回退。
- `session_shutdown` 只清注册表与监听,不杀扫描进程。
- 行为契约以 spec.md 为准;改 spec 必须登记变更记录;触及 design 决策走回退协议。
- commit 中文信息,前缀 `feat:` / `fix:` / `docs:` / `chore:` 等,说明改了什么、原因、影响。

## 验证入口

- 加载:`pi -e ./`(一次性试用,无报错即通过)。
- 单测:`node --test extensions/`(node:test,覆盖 spec 全部 pinned case 与数值预算)。
- Gate A:LLM 接线实测(cs `--dry-run` / `--mock`);Gate B:包集成(pi 加载 + 工具全链路);Gate C:自然语言路由与汇报纪律。
