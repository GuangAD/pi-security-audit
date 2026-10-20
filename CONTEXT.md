# CONTEXT.md — 领域词汇表

pi-security-audit 的领域术语。按需增补,不套模板。

## 引擎模型(scan model)

执行审计 subagent 的 LLM 模型。解析顺序:配置(`~/.pi/agent/security-audit.json`)优先 → 会话模型回退 → 显式报错。与「会话模型」(用户日常对话用)刻意解耦——见 ADR-0003。

## 编排 skill

描述审计工作流的方法论提示词(skills/security-audit*)。pi 主 agent 读它决定「派什么 subagent、按什么顺序、产物写哪」。源自 cs 的 core-scan 等文档(Apache 2.0)改写,改写规则 = spec 的 cs→pi 映射表。

## 调查包(investigation packet)

按攻击面分组的审计任务单元:共享同一攻击者/资产/入口/控制点的一组安全问题,交给一个调查员 subagent。源自 cs core-scan 的 packets 概念。

## 基线审计(baseline audit)

独立的第一遍全量审计,与调查包并行且互不知晓——防止单线程审计被早期假设锚定。cs 反误报机制的一部分。

## 产物四件套

一次审计的完整输出,位于被扫仓库 `.security-audit/<TS>/`(`TS` = `date +%Y%m%d-%H%M%S` 本地时间):

- `scan-context.json` — 扫描上下文(mode/scope/base/model/时间戳),单一事实源。
- `findings.json` — 发现列表,契约 = schemas/findings.schema.json。
- `coverage.json` — 覆盖声明(含 rejected/deferred 处置),契约 = schemas/coverage.schema.json。
- `report.md` — 人类可读报告(严重级别分组 + codeEvidence 证据条目)。

另有 `checkpoints/<阶段>.json` 为各 subagent 阶段检查点(取代 cs 的 record_* MCP 工具)。

## 薄工具

插件注册的两个 pi 工具:`resolve_scan_model`(引擎模型解析)、`validate_scan_artifacts`(产物契约校验)。设计原则:代码只做「确定性计算」,方法论判断留给 agent。

## cs→pi 映射表

知识层改写的唯一机械规则(spec 编码方向):cs 的 codex 运行时 API(fork_turns/record_* MCP/followup_task 等)到 pi 机制(subagent 工具/写文件/新派 subagent)的一一对应。
