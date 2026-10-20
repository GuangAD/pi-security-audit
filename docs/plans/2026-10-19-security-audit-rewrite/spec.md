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
.security-audit/<TS>/  (TS = date +%Y%m%d-%H%M%S,本地时区,禁用 UTC)
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
- **用例详版**(门 2 定稿;实现期照单兑现):

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 配置优先 | 合法配置 + 会话模型存在 | ok, source="config", 返回配置模型 | 本规格数据结构节 |
| 会话回退 | 配置文件不存在 + 会话模型存在 | ok, source="session" | ADR-0003 |
| 损坏 JSON 显式报错 | 配置为非法 JSON + 会话模型存在 | ok:false, reason 含 "损坏配置", **不**回退会话 | 本规格错误行为 |
| 缺 model 字段损坏 | 配置为 `{}` + 会话模型存在 | ok:false, 不回退 | 本规格数据结构节解析规则 |
| model 缺 provider 前缀损坏 | 配置 model="glm-5.3-flash"(无 "/") | ok:false, 不回退 | 本规格数据结构节格式约定 |
| 双缺失报错 | 无配置 + 会话模型 undefined | ok:false, detail 含补救指引 | ADR-0003 |
| configPath 参数重定向 | configPath 指向临时文件 | 按该文件解析(测试注入用) | 签名定义 |

- **覆盖声明**:
  - **等价类矩阵**(全枚举,上表 7 行):配置状态(无/合法/损坏 JSON/缺 model/缺前缀) × 会话模型(有/无) 的可组合项全部出现;「损坏 × 无会话」与「损坏 × 有会话」期望相同(都报错),合并断言不丢行为。
  - **机检铁律**:任一 `ok:true` 结果 `source` 与实际来源一致;任一损坏配置结果 `ok:false` 且 detail 非空——oracle 独立于实现(断言规格不变式,非实现重算)。
  - **枚举范围**:source 取值仅 "config"|"session"(类型约束)。

### extensions/artifact-validator.ts

产物契约校验:轻量 JSON Schema 子集校验器,校验对象为本插件 `schemas/` 下两份已知 schema。

#### validateFindings(doc: unknown, schemaPath?: string): ValidationResult

- **后置条件**:返回 `{ ok: true }` 或 `{ ok: false, errors: Array<{ path, message }> }`;errors 非空时逐条给出 JSON 路径与违规原因(缺必填/类型错/枚举外值)。
- **副作用与可重入性**:纯函数;重复调用结果一致。
- **错误行为**:doc 非 JSON 对象 → ok:false(errors 含根路径类型错);schemaPath 文件缺失 → 抛 Error(调用方配置错误,非数据错误)。
- **用例详版**(门 2 定稿;实现期照单兑现):

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 合法最小文档通过 | 满足 required 的最小 findings 文档 | ok:true | schemas/findings.schema.json required |
| 缺必填字段报错 | findings[0] 缺 severity | ok:false, errors 含 severity 路径 | 同上 required 清单 |
| 枚举外 severity 报错 | severity:"catastrophic" | ok:false, errors 指向 severity 枚举 | schema severity enum |
| 非对象文档报错 | doc="string" / doc=[1,2] | ok:false, errors 含根路径类型错 | 本规格错误行为 |
| 嵌套 $ref 生效 | locations 缺必填子字段 | ok:false, errors 指向嵌套路径 | schema $ref → definitions |
| 多项错误精确定位 | findings[1] 缺 title(第 0 项合法) | ok:false, errors 路径含 "[1]" | 数组 items 语义 |
| schemaPath 缺失抛错 | 指向不存在文件 | throw Error | 本规格错误行为 |

- **覆盖声明**:
  - **required 逐删遍历**(机检):对 finding 的 13 个必填字段逐个生成「缺该字段」文档,断言每个都 ok:false 且 errors 指向该字段——程序化生成,不逐条手写。
  - **枚举范围**:severity 枚举全值合法性(critical/high/medium/low 全过 + 2 个非法值全拦)。
  - **真实 schema 锚点**:校验器必须能加载并应用 cs 原版 findings.schema.json(含 $ref/definitions)——「能校验真实 cs schema」本身是校验器能力的独立 oracle。
#### validateCoverage(doc: unknown, schemaPath?: string): ValidationResult

- 四件套同 validateFindings;校验对象为 coverage.schema.json。
- **用例详版**(门 2 定稿):

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 合法 coverage 通过 | 满足 required 的最小 coverage 文档 | ok:true | schemas/coverage.schema.json required |
| 缺 surfaces 报错 | coverage 缺 surfaces | ok:false, errors 含 "surfaces" | 同上 required |
| deferred 类型错报错 | deferred="none"(应为数组) | ok:false, errors 指向 deferred 类型 | schema deferred 定义 |

### extensions/index.ts

插件入口:注册薄工具与技能资源。

#### registerSecurityAudit(pi: ExtensionAPI): void

- **后置条件**:调用后 `pi.tools` 可见 `resolve_scan_model` 与 `validate_scan_artifacts` 两个工具;重复调用(不应发生)行为未定义——pi 保证单次加载。
- **副作用**:向 pi 注册工具定义。
- **错误行为**:schema 文件缺失不影响插件加载(校验工具运行时报错)。
- **用例详版**(门 2 定稿):

| 用例 | 输入 | 期望 | 事实源 |
|---|---|---|---|
| 工具枚举 | `pi --print -e ./` 加载 | 两工具可枚举且参数 schema 合法 | 本规格后置条件 |
| resolve_scan_model 冒烟 | execute + 临时配置文件 | 返回 ok/ok:false 结构(detail 非空) | scan-model seam |
| validate_scan_artifacts 冒烟 | execute + fixture findings 文档路径 | 返回 ok:true | artifact-validator seam |

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


- 产物目录时间戳明确为本地时区命令(门 3 用户反馈)
  - 原因:端到端实测 agent 用了 UTC 时间戳(SKILL 只写「本地时间」属软约束);改为确定性命令 date +%Y%m%d-%H%M%S 并显式禁用 date -u
  - 影响:SKILL×2/artifact-contract/CONTEXT 同步;格式 YYYYMMDD-HHmmss 不变(Windows 文件名安全),仅时区语义钉死
- resolveScanModel 错误字段语义修正(任务 2)
  - 原因:骨架期用例期望「reason 含损坏配置」为粗略表述;实现确定契约 reason=机器码(config-corrupt/no-model),detail=人类可读文案(含补救指引)
  - 影响:用例 3/4/5 的断言目标由 reason 改为 reason 相等 + detail 正则;对外行为不变(ok:false 与文案语义均保留)
