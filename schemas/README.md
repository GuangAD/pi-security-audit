# Schemas 来源与许可

本目录下的 JSON Schema 文件复制自 OpenAI codex-security(`@openai/codex-security` 0.3.0,`_bundled_plugin/schemas/`),遵循其 Apache License 2.0(见仓库根 LICENSE 或上游包)。

- `findings.schema.json` / `coverage.schema.json` — 扫描产物契约(本插件 validate_scan_artifacts 工具的校验对象)。
- `scan-manifest.schema.json` / `patch-risk-assessment.schema.json` — 上游契约,原样保留备用。
- `definitions/` / `tools/` — 上游公共定义与工具入参 schema,原样保留。

上游版权与许可声明:Copyright OpenAI,Apache License 2.0。修改说明:仅目录位置移动,内容未改;后续如为本插件裁剪,须在此登记。
