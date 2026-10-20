---
name: security-audit-diff
description: 对一次变更做安全审计:指定 commit、分支差异或工作树未提交改动。用户说「审计这次改动 / 审计这个 commit / 扫描 diff / review this change for security」时使用;全库审计用 security-audit skill。
---

# Security Audit(diff 模式)

对一次变更(commit / 分支差异 / 工作树)做聚焦安全审计:inventory = 变更文件,方法论与 paths 模式同源(共享 `../security-audit-shared/references/`),发现仅覆盖变更引入面。

## 与 paths 模式的差异

1. **diff 源(diffTarget)**,三选一:
   - `commit:<sha>` — 审计该 commit 引入的变更(`git show --name-status <sha>`)。
   - `branch:<base>..<head>` — 分支差异(`git diff --name-status <base>...<head>`)。
   - `workingTree` — 未提交改动(`git status --porcelain` + `git diff --name-status`;未跟踪且未被 ignore 的文件也在 inventory 内)。
   - PR 源依赖 gh CLI,默认不支持;用户明确要求且环境可用时按 branch 语义处理。
2. **inventory 构成**:变更文本文件,不看扩展名/目录;被 ignore 规则覆盖的已跟踪变更仍在 scope;删除文件按 base 修订(`git show <base>:<path>`)审读;未变更文件仅在解释变更需要时查看。
3. **安全相关性判定**:按文件行为与可达性评估(含构建/部署/CI 用途),不按路径猜测。
4. **worker 指令差异**:基线审计员改为「变更审阅者」——对照 base 修订读新版本,标记变更引入的风险;未变更的支撑代码按需只读。验证与报告纪律不变(验证回执、反证规则、coverage 处置次序见 `../security-audit-shared/references/final-report.md` 的 diff-scan 段)。
5. **入口未确立 ≠ deferred**:变更引入的新危险 sink,若 source/control/sink 三元组已由源码确证(如拼接构造 SQL 且无参数化),即使本修订内攻击者入口尚未接线(函数未导出/无调用者),处置仍为 **reportable**——入口前置条件写入该 finding 的 `severity.changeConditions`(与 core-scan 第 7 步「公共库边界即充分」一致)。`deferred` 仅用于证据本身不完整的候选(source/control/sink 未凑齐)。

## 编排步骤

1. 调用 `resolve_scan_model`(同 paths 模式;错误即终止并展示 detail)。
2. 建 `.security-audit/<TS>/` + `checkpoints/`,`TS` 用命令 `date +%Y%m%d-%H%M%S` 的输出(bash date 默认本地时区;**禁用** `date -u`/UTC)。写 `scan-context.json`:`{mode:"diff", diffTarget, base, scope:".", model, provider, modelSource, startedAt}`。
3. 构造变更清单:`git diff --name-status`(按 diffTarget 取 base),写 `checkpoints/inventory.json`;删除文件记录 base 修订。
4. 按 `../security-audit-shared/references/security-guidance.md` 解析嵌套 SECURITY.md。
5. 派变更审阅者(并行,按文件分组):每组拿清单子集 + base 修订读取指引;结果写 `checkpoints/investigators/<group>.json`。
6. 威胁建模(变更面):只映射变更触及的边界;写 `checkpoints/threat-model.json`。
7. 汇总候选 → 独立验证(`../security-audit-shared/references/validation-guidance.md`,处置次序见 final-report diff 段)→ `findings.json`/`coverage.json`(coverage.mode="diff")→ `validate_scan_artifacts` 校验 → `report.md`。
8. 汇报:报告全文(或核心节)+ 产物目录路径;明确声明「仅覆盖变更引入面」。

## 安全纪律

继承 paths 模式全部纪律(目标只读、不可信数据、不自动修复、证据锚定);另加:未变更代码的发现**不进** findings——若审计中发现变更外的真实漏洞,写入 report.md 的 Open Questions 提示用户另行全库审计。
