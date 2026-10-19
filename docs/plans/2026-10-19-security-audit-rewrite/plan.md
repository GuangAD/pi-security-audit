# pi-security-audit 重构开发计划

> 设计依据:./design.md(已批准);实现规格:./spec.md(已批准,含接口组与用例表)
> 状态:待批准(门 2 批准后改为:已批准;全部完成后改为:已完成)

## 全局约束

从 design.md「技术栈与依赖约束」逐字继承:

- TypeScript 由 pi 的 jiti 直跑:不设编译、不设 build 脚本。
- 零第三方 npm 依赖:schema 校验自写轻量子集,不引 ajv。
- 运行前提:pi 环境具备 subagent 能力(pi-subagents);skill 声明降级路径。
- 测试:node:test 内置框架,`node --experimental-strip-types --test extensions/*.test.ts`(目录形式不可用)。
- Windows 优先,不依赖 Unix-only 工具。
- 产物目录 `.security-audit/` 必须进 .gitignore。

TDD waiver 预登记:

- 任务 1(清场与文档处置):纯删除与文档,无可测行为;验收替代=grep 断言 + pi 加载实测。
- 任务 4/5/6(skills 改写):提示词资产无可单测行为;验收替代=行数预算机检 + 引用路径存在性断言 + 样本仓库端到端(任务 7)。

## 任务清单

- [ ] 任务 1:清场与插件身份(commit: ____ )
- [ ] 任务 2:schemas 复制 + 引擎模型解析(实现 + 工具)(commit: ____ )
- [ ] 任务 3:产物契约校验器(实现 + 工具)(commit: ____ )
- [ ] 任务 4:shared references 方法论改写(commit: ____ )
- [x] 任务 5:security-audit 主 skill(paths 模式)(commit: 83017c8)
- [x] 任务 6:security-audit-diff skill(commit: 949422d)(commit: ____ )
- [ ] 任务 7:端到端验收与收尾(commit: ____ )

推荐排序即上述编号顺序(任务 4 可与 2/3 并行,但串行执行按编号)。

## 任务详情

### 任务 1:清场与插件身份

- **端到端行为**:仓库只剩新架构的空壳(skills/ 空目录结构、package.json 新名、文档就位);`pi --print -e ./` 加载不报错(暂无工具注册也不报错);全局卸载旧名、重装新名成功。
- **涉及**:
  - 删除:extensions/ 全部 6 文件(5 模块 + 测试)、skills/codex-security-scan/ 全部、.tmp/ 残留(gitignore 内不动 git)。
  - 修改:package.json(name→pi-security-audit、description、keywords 保留 pi-package)、.gitignore(+.security-audit/)、AGENTS.md(重写:新定位/目录职责/工程边界/验证入口)、CONTEXT.md(重置:新术语表)、ROADMAP.md(重置)、docs/adr/0001、0002(头部标注「已被 0003/0004 取代」)。
  - 新建:docs/adr/0003-scan-model-config-first.md、docs/adr/0004-skill-driven-engine.md。
- **编码方向**:纯删除与文档,不写代码;旧 docs/plans/2026-10-16-* 留档不删。
- **接口组**:无(无代码)。
- **数据结构落地**:无。
- **验收标准**:
  - [ ] 机检:`grep -r "codex-security\|@openai/codex" extensions/ skills/ package.json` 零命中(旧 cs 引用清零;git 历史与 docs/plans 归档除外)。
  - [ ] 机检:`pi --print -e ./` 加载零报错。
  - [ ] 机检:package.json name === "pi-security-audit" 且无 dependencies 字段。
  - [ ] 目测:ADR-0003/0004 内容完整(决策/理由/后果);AGENTS.md 无失效指针。
- **依赖**:无。

### 任务 2:schemas 复制 + 引擎模型解析

- **端到端行为**:agent 调用 `resolve_scan_model` 工具,得到当前生效的引擎模型(配置优先/会话回退)或带补救指引的显式报错;cs 的 schemas 契约文件随插件分发。
- **涉及**:
  - 新建:schemas/(从 cs `_bundled_plugin/schemas/` 复制 findings/coverage/scan-manifest/definitions/tools + LICENSE 标注)。
  - 新建:extensions/scan-model.ts、extensions/scan-model.test.ts、extensions/index.ts、extensions/index.test.ts。
- **编码方向**:loadScanConfig 按数据结构节的解析规则;resolveScanModel 纯函数(configPath 可注入);index.ts 装配参照旧 index.ts 的 registerTool 形态(git 历史可考)。
- **接口组**:`extensions/scan-model.ts.resolveScanModel`(红→绿)、`extensions/index.ts.registerSecurityAudit`(红→绿);消费非 seam `loadScanConfig`。
- **数据结构落地**:security-audit.json 配置格式(spec 数据结构节)。
- **验收标准**:
  - [ ] 机检:resolveScanModel 用例表 7 行全绿。
  - [ ] 机检:机检铁律(source 一致性/损坏不回退)断言通过。
  - [ ] 机检:工具枚举用例(`pi --print -e ./`)通过。
  - [ ] 目测:ok:false 时 detail 文案人类可读。
- **依赖**:依赖任务 1 的干净装配点(硬依赖:index.ts 需要全新注册)。

### 任务 3:产物契约校验器

- **端到端行为**:agent 对扫描产物跑 `validate_scan_artifacts` 工具,得到逐字段校验结论;损坏产物在进入报告前被拦截。
- **涉及**:
  - 新建:extensions/artifact-validator.ts、extensions/artifact-validator.test.ts。
  - 修改:extensions/index.ts(注册第二工具)、extensions/index.test.ts。
- **编码方向**:validateAgainstSchema 子集(required/type/enum/items/properties/$ref 内部引用);测试锚点=直接加载 cs 原版 schema(required 逐删遍历程序化生成)。
- **接口组**:`extensions/artifact-validator.ts.validateFindings`、`validateCoverage`(红→绿);消费非 seam `validateAgainstSchema`。
- **数据结构落地**:ValidationResult 形状(spec seam 节)。
- **验收标准**:
  - [ ] 机检:findings 用例表 7 行全绿。
  - [ ] 机检:coverage 用例表 3 行全绿。
  - [ ] 机检:required 逐删遍历(13 字段程序化)全绿。
  - [ ] 机检:severity 枚举全值(4 合法过 + 2 非法拦)。
  - [ ] 机检:工具冒烟用例(fixture 文档 ok:true)。
- **依赖**:依赖任务 2 的 schemas/ 复制与 index.ts 装配点(硬依赖)。

### 任务 4:shared references 方法论改写

- **端到端行为**:两模式 skill 共享的方法论文档就位(验证纪律/产物契约/报告格式/审计核心),全部使用 pi 机制表述,无 codex API 残留。
- **涉及**:
  - 新建:skills/security-audit-shared/references/(core-scan.md、validation-guidance.md、final-report.md、finding-detail-fields.md、static-finding-assessment.md、security-guidance.md、threat-model.md、artifact-contract.md——由 cs 同名文档 + scan-artifacts.md 合并改写)。
- **编码方向**:按 spec「cs→pi 映射表」逐点替换;英文原文保留(cs 提示词资产最小 diff),front-matter/说明性文字中文;MVP 裁剪 deep/workbench 段落。
- **接口组**:无(提示词资产)。
- **数据结构落地**:checkpoints/<阶段>.json 的结构定义(写入 artifact-contract.md)。
- **验收标准**:
  - [ ] 机检:`grep -rn "fork_turns\|record_codex_security\|followup_task\|launch_codex_security\|CODEX_SECURITY_" skills/security-audit-shared/` 零命中。
  - [ ] 机检:shared references 总行数 ≤ 2500(wc -l 测试断言或脚本)。
  - [ ] 目测:映射表 7 项逐一核对改写到位。
- **依赖**:依赖任务 1(skills 旧内容已清空,硬依赖:目录结构就位)。

### 任务 5:security-audit 主 skill(paths 模式)

- **端到端行为**:用户对任意仓库说「安全审计/扫描这个仓库」,pi 主 agent 按 SKILL.md 编排:解析模型 → 建产物目录 → 派基线/威胁建模/调查包 subagent → 独立验证 → 校验产物 → 展示报告。
- **涉及**:
  - 新建:skills/security-audit/SKILL.md、agents/openai.yaml(或 pi 等价 front-matter)。
- **编码方向**:编排指令改写自 cs security-scan SKILL.md + core-scan.md;开头声明 subagent 能力前提与降级路径;产物写入 .security-audit/<ts>/;调用 resolve_scan_model/validate_scan_artifacts 工具。
- **接口组**:消费 `resolve_scan_model`、`validate_scan_artifacts`(作为工具调用约定写入提示词)。
- **数据结构落地**:scan-context.json 字段落地(写入 skill 或 shared 契约)。
- **验收标准**:
  - [ ] 机检:SKILL.md ≤ 300 行(wc -l 断言)。
  - [ ] 机检:引用的 shared references 路径全部存在(测试断言)。
  - [ ] 机检:codex API 零残留(grep 同任务 4)。
  - [ ] 目测:编排步骤完整覆盖 cs 主链(基线/威胁建模/调查包/验证/报告五阶段)。
- **依赖**:依赖任务 4 的 shared references(硬依赖)。

### 任务 6:security-audit-diff skill

- **端到端行为**:用户说「审计这次改动/审计某个 commit」,pi 按 diff 模式编排:git diff 变更清单为 inventory,基线修订读取删除文件,findings 仅覆盖变更引入面。
- **涉及**:
  - 新建:skills/security-audit-diff/SKILL.md。
- **编码方向**:改写自 cs security-diff-scan;diffTarget 参数化(PR/commit/branch/working-tree 四源按 bash 可得性裁剪为 commit/branch/working-tree 三源——PR 依赖 gh,标注可选)。
- **接口组**:同任务 5 的两个工具;继承 shared references。
- **数据结构落地**:scan-context.json 的 base/diffTarget 字段。
- **验收标准**:
  - [ ] 机检:SKILL.md ≤ 200 行(wc -l 断言)。
  - [ ] 机检:shared 引用路径存在性。
  - [ ] 目测:四源差异说明(cs 原文)保留或显式裁剪声明。
- **依赖**:依赖任务 4(硬依赖)。

### 任务 7:端到端验收与收尾

- **端到端行为**:外部观察者视角——全新 pi 环境卸旧装新,对样本仓库跑 paths 与 diff 两模式,产出四件产物且校验通过,报告可读且发现与人工核对一致。
- **涉及**:
  - 新建:.tmp 端到端 fixture(样本仓库,gitignore 内,不入 git)。
  - 修改:README.md(新架构使用说明)、ROADMAP.md(完成态)。
- **编码方向**:fixture 仓库内置两类已知漏洞(硬编码密钥 + SQL 拼接);paths 与 diff 各跑一轮;校验用任务 3 工具。
- **接口组**:无新接口;全链路消费。
- **数据结构落地**:无。
- **验收标准**:
  - [ ] 机检:paths 模式四件产物齐备且 validate 全过。
  - [ ] 机检:diff 模式四件产物齐备且 findings 仅含变更引入项。
  - [ ] 机检:`pi install D:/test/pi-codex-security`(新名)成功,`pi -e ./` 加载正常。
  - [ ] 目测:report.md 按 final-report 契约组织;两处已知漏洞均被发现且证据指向正确位置。
- **依赖**:依赖任务 5、6(硬依赖:两模式 skill 就位)。

## 开发记录

- 任务 6 | 完成 | commit 949422d
  - BASE:78c626d
  - 评审:无发现(34 行 ≤ 200;引用机检 3/3;codex 零残留)
  - waiver:提示词资产(预登记)
  - 结论:diff 三源(commit/branch/workingTree)按 bash 可得性裁剪,PR 源标注可选;关键差异=inventory 变更清单 + 删除文件按 base 修订审 + findings 仅覆盖变更引入面。
## 开发记录

- 任务 1 | 完成 | commit 12fd5b9
  - BASE:e367ec6
  - 评审:无发现(纯删除与文档;三项机检全过:旧引用清零/package.json 断言/pi 加载零报错)
  - waiver:纯删除与文档(预登记)
  - 结论:
    1. 旧 extensions 九文件(5 模块+4 测试)git rm,history 即归档;rebuild 时 registerTool 形态可考古旧 index.ts(git show 38be087:extensions/index.ts)。
    2. ADR-0001/0002 仅头部加「已被取代」标注,正文留档;新 ADR-0003(模型配置优先)/0004(skill 驱动)已落。
- 任务 2 | 完成 | commit 3a194c1
  - BASE:9978cf8
  - 评审:无发现(12/12 测试;mutation「损坏静默回退」3 红→还原 9/9;pi 加载实测过)
  - 变更记录:已登记(reason/detail 语义修正)
  - 结论:
    1. reason=机器码(config-corrupt/no-model)、detail=人类文案——spec 骨架期「reason 含损坏配置」的粗略表述已按此修正并登记变更记录。
    2. typebox 经 gitignored node_modules junction 解析(与旧项目同机制),peerDependencies 已补声明。
- 任务 3 | 完成 | commit 7543748
  - BASE:9978cf8(与任务 2 同基线串行)
  - 评审:自审发现两处——①校验器缺 const 支持(cs schema 大量使用),补实现+守卫用例(mutation 移除 const 1 红→还原 28/28);②测试 fixture 三处不合法(anchor 大写冒号/cwe 应数组/documentType 旧值),均为 fixture 错非校验器错,已修正
  - 结论:
    1. cs schema 契约比直觉严:documentType/schemaVersion 是 const、fingerprints 是对象(algorithm const + primary 强 pattern)、taxonomy.cwe 是数组——fixture 必须照抄 schema 而非凭直觉。
- 任务 4 | 完成 | commit 78c626d
  - BASE:9978cf8(skills 线与 extensions 线并行,同基线)
  - 评审:无发现(机检:codex API 零残留——注:管道 grep 判定要用单命令退出码;563 行 ≤ 2500 预算)
  - waiver:提示词资产(预登记);行数预算与引用存在性替代
  - 结论:
    1. 8 文档:core-scan/validation-guidance/final-report/finding-detail-fields/threat-model/static-finding-assessment/security-guidance/artifact-contract;英文正文最小 diff,头部来源标注中文。
    2. 来源标注里不要出现 codex API 字面(会被自己的零残留机检命中)——描述改写历史用自然语言。
- 任务 5 | 完成 | commit 83017c8
  - BASE:78c626d
  - 评审:无发现(38 行 ≤ 300;引用机检 7/7——注意 skill 内引用路径必须写 ../security-audit-shared/(相对 skill 目录),引用存在性机检脚本从 SKILL.md 抽路径逐条 fs.existsSync)
  - waiver:提示词资产(预登记)
  - 结论:编排 11 步 = 定模型→建目录→预检→基线(async)→威胁建模→调查包(并行)→汇总→独立验证→产物+校验→报告→汇报;每步都落到 checkpoint 文件,中断可恢复。
    2. 子集校验器支持清单:type/required/properties/items/enum/pattern/minLength/maxLength/const/$ref(#/$defs 内部);写测试前先抽 schema 的 required 树与 enum/pattern 清单可少走弯路。
