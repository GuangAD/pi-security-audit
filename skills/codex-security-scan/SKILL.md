---
name: codex-security-scan
description: 在 pi 会话中触发与解读 codex-security(cs)安全扫描。用户说「安全扫描 / 安全审查 / security scan / scan this branch / 扫一下改动」或输入 /security-scan 时使用;覆盖三工具用法(scan/status/run)、扫描结果只读汇报纪律、cs 全部子命令参考与分级安全纪律。
---

# codex-security-scan

本包在 pi 中注册了三个工具(`codex_security_scan` / `codex_security_status` / `codex_security_run`)与 `/security-scan` 命令,封装 OpenAI 的 `cs` CLI(npm 包 codex-security)对当前仓库做安全扫描。扫描引擎的 LLM **自动接线**:跟随会话 `/model`(Responses 协议直连;Chat 协议映射智谱 Codex 端点),凭证零手工配置;协议不兼容时工具会显式报错并提示——按报错指引 `/model` 切换,或让用户写 `<agent-dir>/codex-security.json` 覆盖配置。**不静默换模型。**

## 触发词与路由

用户以下说法都应触发本 skill:

- 「安全扫描」「安全扫描当前分支」「安全审查」「扫描这个分支」
- 「security scan」「scan this branch」「scan this repo」「run a security scan」
- 「扫一下改动」「检查一下工作树有没有安全问题」「深度扫描 src/」
- `/security-scan` 命令(无参默认 diff origin/main;`working-tree` 扫工作树;其余参数作为 diff base 透传)

**路由表(用户说什么 → agent 调什么):**

| 用户说 | agent 调用 |
|---|---|
| 「安全扫描当前分支」 | `codex_security_scan { scope: { kind: "diff", base: "origin/main" } }` |
| 「扫一下工作树的改动」 | `codex_security_scan { scope: { kind: "workingTree" } }` |
| 「深度扫描 src/」 | `codex_security_scan { scope: { kind: "paths", paths: ["src"] }, mode: "deep" }`(**deep 成本/时长不可控(官方上限 96h),发起前必须征询用户**) |
| 扫描完成通知到达后 | `codex_security_status { scanDir: "<scan 返回的路径>" }` → 按下方「解读纪律」汇报 |
| 「用 cs 导出发现」 | `codex_security_run { command: "export", args: ["..."] }` |

扫描是后台任务:scan 立即返回 `scanDir`(产物目录绝对路径,后续查询的唯一凭据)/ `pid` / 脱敏命令行。进程退出后会话会自动收到通知,届时调 status 解读。

**路由纪律(实测教训,不可违反)**:

1. **真实扫描只走 `codex_security_scan`**。`codex_security_run` 跑 `scan` 仅限 `--mock` / `--dry-run` 等辅助场景——run 不做 LLM 接线注入(无 zai provider/env_key),真实扫描会缺凭证或计费错位;bash 直跑同理。scan 工具失败时**不得 fallback 到 run 或 bash**,重试正确参数或向用户报障。
2. **`scope` 参数必须作为对象传入**(如 `{ "kind": "paths", "paths": ["."] }`),不要序列化成 JSON 字符串。扩展已内置字符串修复(prepareArguments),但请始终传对象;若工具报 schema 校验失败,把 scope 写成对象重试。

## 三工具用法

### codex_security_scan — 后台启动扫描

- `scope` 三选一:
  - `{ kind: "diff", base: "origin/main", head?: "..." }` — 已提交改动相对基线(**默认**)
  - `{ kind: "workingTree", base?: "..." }` — 工作树未提交改动
  - `{ kind: "paths", paths: ["src", "lib"] }` — 指定路径
- `mode?: "standard" | "deep"`(默认 standard)。**deep 模式成本/时长不可控(官方上限 96h),发起前必须征询用户确认。**
- `modelOverride?: string` — 单次覆盖扫描模型 id(只换 model,provider/端点/凭证解析不变)。

### codex_security_status — 查询状态

- 入参 `{ scanDir }`。返回 running / completed / failed / unknown;completed 附严重级别计数 + top 发现 + report.md 路径。
- findings 解析失败时降级返回 report.md 路径 + 日志尾部,**不报假状态**。

### codex_security_run — 白名单透传其余 cs 子命令

- 入参 `{ command, args?, timeoutMs? }`,前台执行,输出截断 50KB,默认超时 600s、上限 3600s,退出码透传。
- `login` / `logout` / `mcp` 被直接拒绝(login/logout 指引用户在终端执行;`mcp` 官方明确排除扫描,`scanMcp: false`)。

## 解读纪律(汇报规范)

- **按严重级别只读汇报,顺序 critical → high → medium → low**;同类多的级别可合并计数,关键的逐条给出位置、证据、置信度。
- **以 report.md 为准**(findings.json 仅供 status 工具聚合摘要;两者不一致时信 report.md)。
- **发现不自动改代码**:只汇报,等用户决定是否修复(修复属第一级纪律,见下)。

## cs 命令参考表(24 子命令,经 codex_security_run 透传,scan/status 优先走专用工具)

| 子命令 | 用途 | 关键参数 |
|---|---|---|
| `scan` | 仓库/范围安全扫描(本包经 codex_security_scan 调用) | scope:`--path`/`--diff BASE`/`--working-tree`;`--mode standard\|deep`;`--headless`;`--output-dir`;`--dry-run`;`--mock`;⚠️ `--patch` 属第一级纪律 |
| `policy` | 起草 SECURITY.md | — |
| `validate` | 用源码证据评估候选发现 | — |
| `patch` | 修复发现 | ⚠️ 第一级纪律(改代码) |
| `verify-fix` | 验证修复是否生效 | ⚠️ 第一级纪律(改代码) |
| `scans` | 查看已保存扫描 | — |
| `findings` | 查看已保存发现 | `--json` 可供 status 解析复用 |
| `classify-severity` | 评估严重级别 | — |
| `dedupe` | 发现去重 | — |
| `suggest-owners` | 建议责任人 | — |
| `export` | 导出发现/威胁模型 | ⚠️ 若目标为外部系统属第二级纪律 |
| `import` | 读 GitHub code scanning 告警 | — |
| `publish` | 发布发现 | ⚠️ 第二级纪律(写外部系统) |
| `bulk-scan` | 多仓库扫描 | — |
| `scan-components` | 组件扫描合并 | — |
| `install-hook` | 安装 pre-commit 钩子 | — |
| `login` | 登录 | 🚫 第三级:工具直接拒绝,指引用户在终端执行 `cs login` |
| `logout` | 登出 | 🚫 第三级:工具直接拒绝,指引用户在终端执行 |
| `init` | 项目配置起步 | — |
| `info` | SDK 元数据 | — |
| `feedback` | 反馈 | ⚠️ 第二级纪律(写外部系统) |
| `completions` | 生成 shell 补全 | — |
| `mcp` | MCP 服务模式 | 🚫 第三级:工具直接拒绝(官方排除扫描:`scanMcp: false`) |
| `skills` | 官方手册 skill 同步 | `cs skills add` / `cs skills list` |

> 注:扫描产物使用 cs 默认 state dir,本包不传 `--output-dir`(官方要求产物目录必须在仓库外)。

## 安全纪律(三级,写死)

1. **第一级(改代码)**:`patch` / `verify-fix` / `scan --patch` —— **仅当用户在对话中明确确认后执行**;默认先读 findings 报告再说,不主动发起。
2. **第二级(写外部系统)**:`publish` / `--create-pr` / `feedback` —— **仅当用户明确要求时执行**。
3. **第三级(登录与会话类)**:`login` / `logout` / `mcp` —— 工具直接拒绝;指引用户在终端执行 `cs login`(本包凭证走 pi 会话路线,扫描无需登录)。

## 跨会话边界

完成通知**依赖会话存活**:扫描进程退出时若 pi 会话仍在,会自动收到消息,应立即调 status 并解读。若会话已重启/关闭,通知丢失——凭 scan 返回或落盘在产物目录 `state.json` 中的 scanDir,**主动**调 `codex_security_status { scanDir }` 恢复查询(不依赖会话内存)。

## 官方 skills 提醒

本 skill 只覆盖扫描场景的精简指引。当场景超出本文档范围(需要某个 cs 命令的深度手册,如 `import`/`bulk-scan`/`export` 的高级用法)时,**主动提醒用户**:可运行 `cs skills add` 同步官方 21 个手册 skill(经 `codex_security_run { command: "skills", args: ["add"] }` 即可执行),`cs skills list` 查看已同步列表。
