# AGENTS.md — pi-security-audit

## 项目定位

pi 原生安全审计插件:复用 codex-security(cs)的审计方法论与产物契约(Apache 2.0),以 skill 驱动架构跑在 pi 自己的 subagent 循环上。零 codex/cs 引擎依赖。以 `pi install` 安装交付。

前身 pi-codex-security(cs 接线路线)已被证伪:两天真实使用暴露 4 类 codex 引擎层环境故障,详见 docs/plans/2026-10-19-security-audit-rewrite/design.md。

## 核心目录及职责

- `skills/security-audit/` — 主方法论 skill(paths 全库扫描模式):编排指令(基线审计/威胁建模/调查包/独立验证/报告)。
- `skills/security-audit-diff/` — diff 扫描模式变体 skill。
- `skills/security-audit-shared/` — 两模式共享 references(验证纪律/产物契约/报告格式)。
- `extensions/index.ts` — 插件入口:注册两个薄工具(resolve_scan_model / validate_scan_artifacts)。
- `extensions/scan-model.ts` — 引擎模型解析:配置优先 → 会话回退 → 显式报错。
- `extensions/artifact-validator.ts` — 产物契约校验(轻量 JSON Schema 子集,零依赖)。
- `schemas/` — 产物契约(从 cs 原样复制,Apache 2.0 版权标注保留)。
- `docs/plans/2026-10-19-security-audit-rewrite/` — 本次重构的 design/spec/plan。

## 工作流导航

dev 重流程进行中:门 1、门 2 已批准(2026-10-19),当前处于阶段 3(任务 1 清场起)。恢复中断用 `/dev-resume`,先重读 design.md、spec.md(含变更记录)与 plan.md。

## 文档指针

- 决策快照:`docs/plans/2026-10-19-security-audit-rewrite/design.md`(冻结,改动走回退协议)
- 实现契约:`docs/plans/2026-10-19-security-audit-rewrite/spec.md`(演进须登记变更记录)
- 开发计划与进度:`docs/plans/2026-10-19-security-audit-rewrite/plan.md`
- 难逆转决策:ADR-0003(引擎模型配置优先)、ADR-0004(skill 驱动引擎);ADR-0001/0002 已被取代留档
- 术语:CONTEXT.md

## 工程边界

- TypeScript 由 pi 的 jiti 直跑:不设编译、不设 build 脚本。
- 零第三方 npm 依赖;宿主包只进 peerDependencies。
- 运行前提:pi 环境具备 subagent 能力(pi-subagents);skill 内声明降级路径。
- 扫描产物写被扫仓库 `.security-audit/<时间戳>/`(已 gitignore),不写 agent-dir。
- cs 知识层资产(Apache 2.0)忠实改写:仅替换运行时 API 调用点(映射表见 spec 编码方向),不精简方法论。
- 测试用 node:test 内置框架,文件放 `extensions/*.test.ts`(目录形式 `node --test extensions/` 在本机 Node v24 不可用)。

## 执行纪律

- 损坏配置显式报错,不静默降级(ADR-0003)。
- 不发明宿主没有的 API:pi 扩展只依赖经过实测的宿主接口。
- commit 中文信息,前缀 `feat:` / `fix:` / `docs:` / `chore:`,说明改了什么、原因、影响。

## 验证入口

- 加载:`pi -e ./`(一次性试用,无报错即通过)。
- 单测:`node --experimental-strip-types --test extensions/*.test.ts`。
- 端到端:样本仓库(fixture:硬编码密钥 + SQL 拼接)两模式跑通,产物过 validate_scan_artifacts。
