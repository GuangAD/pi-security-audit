# 0004 - Skill 驱动引擎:编排逻辑在提示词,不在代码

日期:2026-10-19 | 状态:已采纳

## 背景

旧插件(pi-codex-security)用约 1500 行 TypeScript 实现 cs 接线(模型接线/进程管理/产物解析/执行器),把扫描编排委托给 cs CLI,而 cs 又把 agent 循环委托给 codex 引擎。两天真实使用暴露 4 类环境故障(web_search 网关拒、Windows 沙箱 DLL 锁、沙箱账户 1909、credential ACL),全部位于 codex 引擎层,修复权不在本包。

同时确认:cs 的核心资产是 Apache 2.0 的审计方法论提示词(约 8000 行)与产物契约(JSON Schema),它们**引擎无关**。

## 决策

新架构 **Skill 驱动**:

1. 编排逻辑(威胁建模 → 派调查包 → 独立验证 → 报告)写在改写后的 skills 提示词里,由 pi 主 agent 按方法论自主派发 subagent 执行。
2. 插件代码只保留两个薄工具:resolve_scan_model(引擎模型解析)、validate_scan_artifacts(产物契约校验)。
3. 产物契约(JSON Schema)从 cs 原样复制,保留 Apache 2.0 版权标注。
4. 零 codex/cs 依赖;旧接线代码全部删除(git 历史即归档)。

放弃的备选:

- SDK 编排(代码写死流水线):可控但僵化,代码量大,且仍需自建 agent 循环——pi 的 subagent 能力已提供该循环。
- 保留 cs 引擎只重构代码:环境问题根因不变。

## 理由

- 承认并接受 skill 驱动的代价:编排一致性靠提示词纪律而非代码保障。cs 方法论本身就是「写给 agent 的指令」,与 skill 形态天然契合。
- 环境敏感度从「codex 引擎本机状态」收敛为「pi 自身」——后者的故障由 pi 上游承担,本包不再夹带第三方引擎。

## 后果

- 扫描质量取决于:方法论提示词质量 + 执行 subagent 的模型能力 + pi subagent 编排可靠性。
- 长任务的检查点机制从「cs 内建」退化为「产物目录文件约定」(checkpoints/<阶段>.json),中断恢复靠重读产物目录。
- 薄工具的 schema 校验是自写子集(零依赖纪律),仅覆盖所用 schema 特性。
