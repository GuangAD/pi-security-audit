# ROADMAP.md — pi-security-audit

## 项目定位

pi 原生安全审计插件:复用 cs(Apache 2.0)审计方法论,skill 驱动 subagent 审计,零 codex 引擎依赖。

## 进行中

- dev 重流程阶段 3(门 1、门 2 已批准):按 `docs/plans/2026-10-19-security-audit-rewrite/plan.md` 执行 7 任务。
  - [x] 任务 1:清场与插件身份(commit: 12fd5b9)
  - [x] 任务 2:schemas 复制 + 引擎模型解析(commit: 3a194c1)
  - [x] 任务 3:产物契约校验器(commit: 7543748)
  - [ ] 任务 4:shared references 方法论改写
  - [ ] 任务 5:security-audit 主 skill(paths)
  - [ ] 任务 6:security-audit-diff skill
  - [ ] 任务 7:端到端验收与收尾

## 最近完成

- 2026-10-19 16:3x 门 2 批准(`e367ec6`):spec 用例详版(resolveScanModel 7 例/validateFindings 7 例/validateCoverage 3 例/registerSecurityAudit 3 例,含覆盖声明)+ plan 7 任务(tracer-bullet 纵切,依赖 DAG 1→2→3、1→4→5/6→7)。验证方式:用户逐项审阅后明确批准。
- 2026-10-19 16:1x 门 1 批准(`2c7c8a2`):design.md(决策快照:skill 驱动/竖切范围/模型优先级反转/产物仓库内)+ spec.md 骨架(4 seam 四件套+穷举清单)。验证方式:design-checklist 自查通过,用户批准。
- 2026-10-19 15:xx cs 移植评估(访谈前置调研):cs 三层解剖(知识层 8036 行 Apache 2.0/编排层 3 万行/codex 引擎)——结论:知识层引擎无关可直接复用,codex 引擎是环境问题集中地,催生本次重构。验证方式:源码实读(cs dist/api.js/cli.js/schemas/skills)。

## 待确认

- 无。

## 已证伪路线(留档)

- cs/codex 接线路线(pi-codex-security v0.1,git 历史留档):两天真实使用暴露 web_search 网关拒、Windows 沙箱 DLL 锁、沙箱账户 1909、credential ACL 四类故障,根因在 codex 引擎层,修复权不在本包。决策:清空重构(ADR-0003/0004)。
