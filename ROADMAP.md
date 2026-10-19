# ROADMAP.md — 项目进度快照

## 当前状态

- **进行中**:dev 重流程门 3——全部 5 任务完成,最终报告已呈报,等待用户确认后收尾。
- 门 1 已批准(2026-10-16):design.md + spec.md 骨架落盘并提交。
- 门 2 已批准(2026-10-16):spec 用例详版 + plan.md 任务计划获批。

## 进行中事项

- (无阻塞项)

## 待确认

- ~~GLM 对 Codex effort 档位兼容性~~ → 已验证(2026-10-16):真实 GLM-5.3 接受默认 `xhigh`,token 流正常无拒绝。
- ~~Windows 下 cs `.cmd` 垫片与 detached 进程行为~~ → 已验证(2026-10-16):垫片解析直 spawn 保真 argv;detached+fd 直传 stdio,父进程退出后子进程日志仍完整(守卫测试钉住)。
- **遗留(非阻塞)**:无。Windows 真实扫描三道环境拦截(auth 预检 / credential-home ACL / `--max-cost` 计量)已于 `c54b0b7` 实验固化解决。
## 最近完成

- 2026-10-16 05:13 设计访谈与门 1:完成 dev 重流程阶段 1 访谈(模型跟随语义、全覆盖范围、凭证传递、后台+通知等 14 项决策收敛),写 design.md、spec.md 骨架、CONTEXT.md(10 词条)、ADR-0001/0002,用户批准门 1。验证方式:design-checklist 逐条自查通过,呈报文档用户确认。

## 待办

- 阶段 2:spec 用例详版(每 seam 3-8 条 + 覆盖声明)→ plan.md(tracer-bullet 切任务)→ 门 2。
- 阶段 3:按 plan 逐任务实现(依赖顺序:llm-wiring → scan-runner → findings-parser → index 装配 → SKILL.md),每任务 TDD + code-review + 提交。
- Gate A/B/C 验证;收尾(清理、最终报告过门 3)。
