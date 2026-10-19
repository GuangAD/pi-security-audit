# ROADMAP.md — pi-security-audit

## 项目定位

pi 原生安全审计插件:复用 cs(Apache 2.0)审计方法论,skill 驱动 subagent 审计,零 codex 引擎依赖。

## 进行中

- 无(门 3 待用户确认收尾)。

## 最近完成

- 2026-10-19 20:xx 任务 2-7 全部完成(实现 commit `3a194c1`/`7543748`/`78c626d`/`83017c8`/`949422d`/`f506114`):引擎模型解析 + 产物契约校验器(29 测试,含 const/$ref 子集与守卫)+ 方法论 8 文档改写(563 行)+ 两模式 skill + 端到端验收(paths 3 发现含运行时复现 / diff 1 发现,产物全过契约校验,目标树零改动)+ receiptRefs 契约矛盾修复(schema 放宽 + 裁剪登记)。验证方式:29/29 测试、mutation check、pi 加载实测、双模式真实审计实测。
- 2026-10-19 16:3x 门 2 批准(`e367ec6`):spec 用例详版 + plan 7 任务。验证方式:用户逐项审阅后明确批准。
- 2026-10-19 16:1x 门 1 批准(`2c7c8a2`):design.md + spec.md 骨架。验证方式:design-checklist 自查通过,用户批准。
- 2026-10-19 15:xx cs 移植评估(访谈前置调研):cs 三层解剖——知识层 8036 行 Apache 2.0 引擎无关可复用,codex 引擎是环境问题集中地。验证方式:源码实读。

## 待确认

- 门 3 收尾:清理端到端 fixture(.tmp/fixture-repo,gitignore 内)、确认交付。

## 已证伪路线(留档)

- cs/codex 接线路线(pi-codex-security v0.1,git 历史留档):两天真实使用暴露 web_search 网关拒、Windows 沙箱 DLL 锁、沙箱账户 1909、credential ACL 四类故障,根因在 codex 引擎层,修复权不在本包。决策:清空重构(ADR-0003/0004)。
