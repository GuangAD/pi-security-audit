# pi-security-audit 实现规格(spec)

> 日期:2026-10-19 | 状态:骨架(门 1 批准后为:骨架已批准;门 2 用例详版批准后改为:已批准)
> 设计依据:./design.md(已批准)
> 流程:dev 重流程阶段 1 起草骨架,阶段 2 补全用例详版
>
> 与 design.md 的分工:design.md 是决策快照,门 1 批准后冻结;本文件是实现契约,随开发演进——任何修订必须登记到文末「变更记录」。两者冲突时以 design.md 为准;修订触及 design.md 决策时走回退协议,禁止就地改本文件了事。

## 数据结构说明

### 引擎配置文件 `<agent-dir>/security-audit.json`

```jsonc
{
  "model": "provider-id/model-id",  // 可选;引擎(subagent)模型
  "provider": "cc-switch-zhipu-glm" // 可选;provider 覆盖(缺省从 model 拆分)
}
```

- 解析:缺文件 → 无配置;非法 JSON 或缺 `model` 字段 → 视为**损坏配置**(显式报错,不静默降级)。

### 产物目录布局(被扫仓库内)

```text
.security-audit/<YYYYMMDD-HHmmss>/
├── scan-context.json    # 扫描上下文:mode/scope/base/model/时间戳
├── findings.json        # 符合 schemas/findings.schema.json
├── coverage.json        # 符合 schemas/coverage.schema.json
├── report.md            # 人类可读报告(final-report 契约)
└── checkpoints/         # 各 subagent 阶段检查点(baseline/threat-model/investigators/validation)
```

### 产物契约

- 原样复用 cs 的 `schemas/findings.schema.json` 与 `schemas/coverage.schema.json`(Apache 2.0)。
- findings 顶层必填:`documentType, schemaVersion, scanId, findings[]`。
- finding 必填:`findingId, occurrenceId, ruleId, identity, fingerprints, title, summary, severity, confidence, taxonomy, locations, remediation, provenance`。
- coverage 顶层必填:`documentType, schemaVersion, scanId, mode, inventoryStrategy, includePaths, excludePaths, surfaces, explicitExclusions, deferred`。
- report.md 结构遵循 cs 的 `final-report.md` 契约(标题层级/严重级别分组/证据条目)。

## seam 接口规格

### extensions/scan-model.ts

引擎模型解析:配置优先 → 会话回退 → 显式报错(新 ADR-0003)。

#### resolveScanModel(configPath?: string, sessionModel?: unknown): ScanModelResult

- **后置条件**:返回 `{ ok: true, provider, model, source: "config" | "session" }` 或 `{ ok: false, reason, detail }`;`source` 标明模型来源;detail 含补救指引(修配置或切会话模型)。
- **副作用与可重入性**:读配置文件一次;纯函数语义,重复调用结果一致(文件未变时)。
- **错误行为**:损坏配置(非法 JSON / 缺 model)→ `ok:false`(不静默降级);无配置且无会话模型 → `ok:false`。
- **pinned case**(门 1 至少 1 条;门 2 前 3-8 条):

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 配置优先 | 配置文件存在且合法 + 会话模型存在 | ok, source="config", 返回配置模型 | 本规格数据结构节 |
| 会话回退 | 配置文件不存在 + 会话模型存在 | ok, source="session" | ADR-0003 |
| 损坏配置显式报错 | 配置文件为非法 JSON | ok:false, reason 含 "损坏配置", **不**回退会话 | 本规格错误行为 |
| 双缺失报错 | 无配置 + 会话模型 undefined | ok:false, detail 含补救指引 | ADR-0003 |

### extensions/artifact-validator.ts

产物契约校验:轻量 JSON Schema 子集校验器,校验对象为本插件 `schemas/` 下两份已知 schema。

#### validateFindings(doc: unknown, schemaPath?: string): ValidationResult

- **后置条件**:返回 `{ ok: true }` 或 `{ ok: false, errors: Array<{ path, message }> }`;errors 非空时逐条给出 JSON 路径与违规原因(缺必填/类型错/枚举外值)。
- **副作用与可重入性**:纯函数;重复调用结果一致。
- **错误行为**:doc 非 JSON 对象 → ok:false(errors 含根路径类型错);schemaPath 文件缺失 → 抛 Error(调用方配置错误,非数据错误)。
- **pinned case**:

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 合法文档通过 | 满足 findings.schema 最小文档 | ok:true | schemas/findings.schema.json required |
| 缺必填字段报错 | findings[] 项缺 severity | ok:false, errors 含 "severity" 路径 | 同上 required 清单 |
| 枚举外值报错 | severity:"catastrophic"(非枚举值) | ok:false, errors 指向 severity 枚举 | schema 的 severity enum |

#### validateCoverage(doc: unknown, schemaPath?: string): ValidationResult

- 四件套同 validateFindings;校验对象为 coverage.schema.json。
- **pinned case**:缺 `surfaces` 必填 → ok:false 且 errors 含 "surfaces"。

### extensions/index.ts

插件入口:注册薄工具与技能资源。

#### registerSecurityAudit(pi: ExtensionAPI): void

- **后置条件**:调用后 `pi.tools` 可见 `resolve_scan_model` 与 `validate_scan_artifacts` 两个工具;重复调用(不应发生)行为未定义——pi 保证单次加载。
- **副作用**:向 pi 注册工具定义。
- **错误行为**:schema 文件缺失不影响插件加载(校验工具运行时报错)。
- **pinned case**:加载后两工具可枚举且参数 schema 合法(pi `--print -e ./` 实测)。

## 接口面穷举清单

- `extensions/index.ts.registerSecurityAudit` — seam — pi 插件入口。
- `extensions/scan-model.ts.resolveScanModel` — seam — 引擎模型解析(配置优先)。
- `extensions/scan-model.ts.loadScanConfig` — 非 seam — 读配置文件(缺失/非法语义见数据结构节);重用语义:纯函数。
- `extensions/artifact-validator.ts.validateFindings` — seam — findings 契约校验。
- `extensions/artifact-validator.ts.validateCoverage` — seam — coverage 契约校验。
- `extensions/artifact-validator.ts.validateAgainstSchema` — 非 seam — 通用子集校验核心;重用语义:纯函数。
- `skills/**` — 非 seam — 提示词资产,验收见「非 seam 模块与视觉验收」。
- `schemas/**` — 非 seam — 数据文件(从 cs 复制,Apache 2.0 版权标注保留)。

## 非 seam 模块与视觉验收

- **skills/security-audit/**(paths 模式):
  - 验收:对含已知漏洞的样本仓库(如自建 fixture:一处硬编码密钥 + 一处 SQL 拼接)跑通全流程,产出四件产物;findings.json 过 validate 工具;report.md 含严重级别分组与 codeEvidence 证据条目。
- **skills/security-audit-diff/**(diff 模式):
  - 验收:对样本仓库构造一次含漏洞引入的 commit,以该 commit 为 diffTarget 跑通,findings 仅覆盖变更引入面。
- **skills/security-audit-shared/**:
  - 验收:两模式 SKILL.md 均正确引用共享 references,无复制粘贴分叉(机检:两主 SKILL.md 对 shared 文件的引用路径存在性断言)。
- **数值预算(机检)**:
  - 主 SKILL.md ≤ 300 行、shared references 总量 ≤ 2500 行——`wc -l` 测试断言(防止方法论无限膨胀)。
  - extensions/ 零第三方依赖——package.json 无 dependencies 字段断言(测试读 package.json)。
- **门 3 用户目测清单**:样本仓库扫描报告可读性;报告中的发现与人工核对一致。

## 编码方向

### cs 运行时 API → pi 对应物映射表(改写 knowledge 层的唯一机械规则)

| cs 机制 | pi 对应物 |
|---|---|
| subagent allowance / fork_turns:"none" | subagent 工具(parallel/async workflow) |
| record_codex_security_scan_draft 等检查点 MCP | 写 `checkpoints/<阶段>.json` |
| followup_task / send_message | 对未完成项派新 subagent(在 skill 中注明) |
| launch_codex_security_mcp --helper resolve-security-md | bash 读目标仓库 SECURITY.md |
| list/prepare_codex_security_review_items | `git diff --name-only <base>`(diff 模式) |
| CODEX_SECURITY_SCAN_ID / SCAN_DIR 环境变量 | scan-context.json 单一事实源 |
| workbench / deep 机制 | 删除(非目标) |

### 实现顺序(编号步骤)

1. 复制 cs schemas/ 目录 + LICENSE 版权标注。
2. scan-model.ts + 测试(红→绿)。
3. artifact-validator.ts + 测试(红→绿)。
4. index.ts 装配 + 加载实测。
5. 改写 shared references(验证纪律/产物契约/报告格式)。
6. 改写 security-audit 主 skill(paths)。
7. 改写 security-audit-diff skill。
8. .gitignore + package.json 改名 + 文档处置(ADR/CONTEXT/ROADMAP/AGENTS)。

### 已知的坑

- subagent 产出大 JSON 时走文件(write 到产物目录),不靠 output 文本回传——上下文膨胀与截断风险。
- pi 工具 execute 的 ctx.model 可能 undefined(会话未选模型)——resolveScanModel 的回退分支必须覆盖。
- cs 的 SKILL.md front-matter 触发词描述含 codex 场景,改写时 description 必须重写(pi 的 skill 触发按 description 匹配)。
- Windows 路径:产物目录时间戳用 `YYYYMMDD-HHmmss`(冒号在 Windows 文件名非法)。

## 变更记录

- 无
