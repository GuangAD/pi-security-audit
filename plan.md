# 在 pi 中集成 codex-security 安全扫描（extension + skill）

## 目标

在 pi 会话中一句「安全扫描这个分支」即可触发 codex-security 扫描本分支相对基线的改动，LLM 通信走用户已有的 Z.ai GLM Coding Plan（不走 OpenAI 计费；与 pi 会话自身所用模型无关），结果由 pi 解读汇报。

## 已核实事实（调研结论，不再重复验证）

- `cs` CLI 已安装（`C:\nvm4w\nodejs\cs`，实测 `codex-security@0.3.0`，内嵌 Codex 0.162.1），`cs scan` 是官方无头宿主，与 Codex 插件同引擎同产物（report.md / findings.json / scan-manifest.json / coverage.json）。
- pi 支持扩展（`~/.pi/agent/extensions/*.ts`，jiti 直跑 TS）：`registerTool` / `registerCommand` / `registerMcpServer`；工具支持 TypeBox schema、`onUpdate` 流式进度（execute 签名 `(id, params, signal, onUpdate, ctx)`，已核对 examples/extensions）、`structuredContent`。
- pi 支持标准 Agent Skills（`~/.agents/skills/<name>/SKILL.md`）。
- cs 支持自定义 LLM 网关：`--codex 'model_provider="..."'` + `--codex 'model_providers.<name>.<key>=VALUE'`（源码帮助文本明确支持 TOML KEY=VALUE 覆盖）。注意 `--provider` 一级参数仅 openai / openrouter / fireworks / amazon-bedrock，zai 只能走 `--codex` 注入内嵌 Codex 的 `model_providers`。
- Z.ai GLM Coding Plan 端点（官方文档 docs.z.ai）：Codex 专用 Responses `https://api.z.ai/api/v1`，Chat Completions `https://api.z.ai/api/coding/paas/v4`，Anthropic `https://api.z.ai/api/anthropic`。GLM-5.3 已全档位支持，模型名 `glm-5.3`。
- cs 扫描范围三选一：`--diff BASE` / `--working-tree` / `--path P`；另有 `--mode {standard,deep}`、`--max-cost`、`--headless`、`--output-dir`、`--dry-run`。`--output-dir` 官方要求「Artifact directory outside the repository」。
- **Codex 已移除 chat wire**：`wire_api = "chat"` 直接报错退出（codex-rs `CHAT_WIRE_API_REMOVED_ERROR`：「is no longer supported, set wire_api = "responses"」）。回退矩阵不再有 chat 协议档。
- cs 官方 MCP 模式不支持扫描（`cs info` 显示 `scanMcp: false`，「Scans are CLI-only because the MCP transport cannot cancel active commands」）——「不移植 MCP 状态机」从性价比决策升级为官方硬约束。
- cs 官方提供 21 个 CLI 手册 skill（`cs skills add/list` 可一键同步，非「16 个 skill」且不存在移植成本）；对 pi 太重，仍自写精简 skill。

## 假设（如不符请指出）

1. Z.ai 密钥经环境变量 `ZAI_API_KEY` 提供，扩展代码与配置文件不落明文。（待确认：当前会话环境未见 `ZAI_API_KEY`，实施前确认其在扫描子进程环境中可用。）
2. 默认扫描范围 = 当前分支相对 `origin/main` 的已提交改动（`--diff origin/main`），基线可参数化。
3. 扫描产物默认输出到项目 `.tmp/codex-security/<时间戳>/`（临时产物目录；步骤中包含把 `.tmp/` 加入 `.gitignore` 的检查）。**与 `--output-dir` 官方「outside the repository」要求冲突，Gate A 实测：若 cs 拒绝仓库内路径，回退到 `CODEX_SECURITY_STATE_DIR` 指向的仓库外目录，`.tmp/` 只留扫描摘要副本。**
4. ~~默认扫描模型 `glm-5.3`~~（已转为事实，见上）；`--effort` 不显式设置、沿用 cs 默认 `xhigh`——若 GLM-5.3 拒绝该档位，Gate A 实测后降档固化。

## 不做什么（范围边界）

- 不移植 Codex 插件的 MCP 状态机与官方 21 个 CLI 手册 skill：MCP 路线被官方硬约束排除（`scanMcp: false`，scan 仅 CLI）；21 个 skill 一键同步即可获得但对 pi 过重，自写一个精简 skill 覆盖扫描场景（已论证放弃路线 B）。
- 不做自动修复（不接 `cs patch`）；发现先汇报，修复需用户确认后另行处理。
- 不做 CI 集成、workbench UI、deep scan 并行 worker 编排。
## 步骤细节

### 步骤 1 细节：基准命令模板与回退矩阵

基准命令模板（验证后固化）：

```bash
cs scan . --diff origin/main --headless \
  --output-dir .tmp/codex-security/<ts> \
  --codex 'model_provider="zai"' \
  --codex 'model_providers.zai.name="Z.ai"' \
  --codex 'model_providers.zai.base_url="https://api.z.ai/api/v1"' \
  --codex 'model_providers.zai.env_key="ZAI_API_KEY"' \
  --codex 'model_providers.zai.wire_api="responses"' \
  --model glm-5.3
```

回退矩阵（按序尝试；chat 协议档已删除——Codex 0.162.1 起 `wire_api="chat"` 直接报错移除）：responses 端点不通 → 先核 `ZAI_API_KEY`、配额与网络（GLM Coding Plan 已转积分制，配额耗尽也会表现为鉴权/请求失败），修配置后重试；仍不通 → 换 cs 一级 `--provider openrouter`（官方四选一之一，同引擎直连，不引入翻译代理）；自定义 provider 被凭证门槛拦截 → 尝试 `--auth api-key` 路径，仍不通则留存失败证据如实报告阻塞。

### 步骤 2 细节：工具契约与实现要点

- codex_security_scan 参数（TypeBox）：scope: {diff: string} | {workingTree: boolean} | {paths: string[]}，mode?: standard/deep，model?，maxCost?；行为：预检（cs 可用、基线存在、ZAI_API_KEY 存在）→ 后台扫描，stdout/stderr 落扫描目录日志 → 立即返回 {scanDir, logPath, pid, command}。
- codex_security_status 参数：scanDir: string；行为：查进程存活 + 日志尾部；进程结束且 report.md 存在时解析 findings.json 的严重级别计数与 top findings（位置、证据、置信度），返回 structuredContent + 报告绝对路径；findings.json 缺失或解析失败时降级返回 report.md 路径 + 日志尾部，不报假状态。解析优先复用官方命令（`cs findings --json` 读同一扫描产物），手解析仅作 fallback。
- /security-scan [args] 命令：简写参数，触发 agent 调用工具走完整流程。
- 实现要点：进程注册表用模块级 Map（会话级）；**pid 与命令行同时落盘到扫描目录**（写入 scan 旁的状态文件），扩展 reload 或会话重启后 status 可凭 scanDir + pid 文件恢复查询，不依赖 Map；**`session_shutdown` 释放资源（pi 扩展契约）：默认不杀扫描进程（detached 放它跑完），只清理句柄与临时状态**；命令模板为模块级常量（步骤 1 结果）；函数带作用/参数/返回值注释。

## 交付物

1. `~/.pi/agent/extensions/codex-security.ts`（扩展，两个工具 + 一个命令）
2. `~/.agents/skills/codex-security-scan/SKILL.md`（skill）
3. Gate A/B/C 验证记录（含 GLM 接线实测结论与最终命令模板）

## 风险与回退（汇总）

| 风险 | 处置 |
|---|---|
| Z.ai responses 端点 / 鉴权不通 | 步骤 1 回退矩阵逐步尝试，全部失败则留存证据报告，改走 `--provider openrouter` |
| wire_api="chat" 回退 | 已从矩阵删除（Codex 0.162.1 直接报错移除 chat wire），仅存 responses |
| `--output-dir` 拒绝仓库内路径 | Gate A 实测；被拒则回退 `CODEX_SECURITY_STATE_DIR` 仓库外目录，`.tmp/` 留摘要副本 |
| GLM 产出 findings.json 契约不稳 | status 工具容错降级读 report.md；skill 提示模型以 report.md 为准 |
| 扫描时长长 | 后台 + 轮询设计，不阻塞 pi 会话 |
| --max-cost 对第三方 provider 未必计量 | 以实际输出为准，必要时改用 --max-time-hours 限制；GLM Coding Plan 按积分计费，USD 阈值天然失准 |
| GLM 不接受 effort=xhigh | Gate A 实测；被拒则 `--effort high`（或 GLM 支持档位）固化进命令模板 |
| pi 会话结束时扫描未完成 | detached 进程继续跑完，pid 落盘，重启后凭 scanDir 恢复查询 |
Plan:
1. GLM 接线验证（Gate A）：用 cs scan --dry-run 验证 --codex 自定义 provider 参数解析，再对项目内小目录跑真实扫描（--path + --max-cost 限制），验证 Z.ai 鉴权与协议接通、产物生成、推理走 GLM，固化最终命令模板（含回退矩阵，见步骤 1 细节）。**另验证三点：`--output-dir` 是否接受仓库内路径（不接受则切仓库外 + .tmp 摘要副本）；GLM-5.3 是否接受默认 effort=xhigh（拒绝则降档固化）；`ZAI_API_KEY` 在扫描子进程环境中确实可用。**
2. 编写 pi 扩展 ~/.pi/agent/extensions/codex-security.ts：单文件 TypeScript，注册 codex_security_scan（后台 spawn 扫描返回 handle）与 codex_security_status（轮询状态、解析 findings 摘要）两个工具、/security-scan 一个命令；密钥从环境变量注入子进程，不落盘（契约见步骤 2 细节）。
3. 编写 pi skill ~/.agents/skills/codex-security-scan/SKILL.md：优先用扩展工具、扩展不可用时降级 bash 直跑 cs scan；规定按严重级别只读汇报的解读纪律；场景路由（分支 diff 默认 / 工作树 / 指定路径；deep 须单独征询用户）。
4. 集成验证 Gate B：pi 加载扩展无报错，小范围触发扫描 → 状态轮询到完成 → 结构化摘要与 report.md 解读全链路通过。
5. 集成验证 Gate C：自然语言「安全扫描一下当前分支」正确路由到 skill，汇报格式符合解读纪律。
6. 收尾检查：grep 确认密钥未出现在扩展、skill、日志、配置文件；.tmp/ 已进 .gitignore；确定旧扫描产物清理策略（保留最新一次）。
