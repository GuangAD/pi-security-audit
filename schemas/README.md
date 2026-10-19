# Schemas 来源与许可

本目录下的 JSON Schema 文件复制自 OpenAI codex-security(`@openai/codex-security` 0.3.0,`_bundled_plugin/schemas/`),遵循其 Apache License 2.0(见仓库根 LICENSE 或上游包)。

- `findings.schema.json` / `coverage.schema.json` — 扫描产物契约(本插件 validate_scan_artifacts 工具的校验对象)。
- `scan-manifest.schema.json` / `patch-risk-assessment.schema.json` — 上游契约,原样保留备用。
- `definitions/` / `tools/` — 上游公共定义与工具入参 schema,原样保留。

上游版权与许可声明:Copyright OpenAI,Apache License 2.0。修改说明:仅目录位置移动,内容未改;后续如为本插件裁剪,须在此登记。

## 本插件裁剪登记

- `coverage.schema.json` `surfaces[].receiptRefs.items.pattern`(2026-10-19,端到端任务 7):原 pattern 强制 `artifacts/` 前缀(cs 语义:MCP 回执在 artifacts/ 下);本插件回执写 `checkpoints/`(见 skills/security-audit-shared/references/artifact-contract.md),两者矛盾且不可同时满足(端到端审计实际命中)。放宽为任意相对路径,保留防目录穿越(`..`)与反斜杠负向断言。
