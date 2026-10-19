# pi-security-audit

pi 原生安全审计插件:复用 codex-security(cs)的审计方法论与产物契约(Apache 2.0),以 **skill 驱动**架构跑在 pi 自己的 subagent 循环上——**零 codex/cs 引擎依赖**。

## 安装

```bash
pi install D:/test/pi-codex-security   # 目录名沿用,包名为 pi-security-audit
```

运行前提:pi 环境具备 subagent 能力(pi-subagents)。缺失时 skill 自动降级为主会话内串行审计(报告中标注「非独立基线」)。

## 使用

| 你说 | 触发 |
|---|---|
| 「扫描这个仓库 / 安全审计 src 目录」 | security-audit skill(paths 模式) |
| 「审计这个 commit / 审计这次改动 / 扫 diff」 | security-audit-diff skill(diff 模式) |

两种模式都会:解析引擎模型 → 建产物目录(被扫仓库 `.security-audit/<时间戳>/`,已 gitignore)→ 派基线/威胁建模/调查包/验证 subagent → 产出 `findings.json` / `coverage.json` / `report.md`(契约见 `schemas/`)→ 契约校验 → 展示报告。

## 引擎模型配置(可选)

默认回退当前会话模型。要固定扫描引擎(推荐——扫描需要稳定可预算的模型),写 `~/.pi/agent/security-audit.json`:

```json
{ "model": "provider-id/model-id" }
```

配置优先级与损坏配置的显式报错语义见 `docs/adr/0003-scan-model-config-first.md`。

## 工具

| 工具 | 用途 |
|---|---|
| `resolve_scan_model` | 解析引擎模型(审计派发前必调) |
| `validate_scan_artifacts` | 校验产物契约(findings/coverage),报告前必调 |

## 方法论来源与许可

审计方法论改写自 OpenAI codex-security(`@openai/codex-security`,Apache License 2.0):多 subagent 审计(独立基线/威胁建模/调查包/逐候选验证)、反误报纪律、产物契约。改写映射见 `docs/plans/2026-10-19-security-audit-rewrite/spec.md`。

## 文档

- 架构与决策:`docs/plans/2026-10-19-security-audit-rewrite/design.md`
- 实现契约:`docs/plans/2026-10-19-security-audit-rewrite/spec.md`
- 进度台账:`docs/plans/2026-10-19-security-audit-rewrite/plan.md`
- 领域术语:`CONTEXT.md`;决策记录:`docs/adr/`
