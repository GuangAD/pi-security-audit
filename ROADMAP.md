# ROADMAP.md — 项目进度快照

## 当前状态

- **已交付**:dev 重流程门 3 通过(2026-10-19),全部 5 任务完成,86 测试全绿,pi 加载正常。交付物见「交付物」节。
- 门 1 已批准(2026-10-16):design.md + spec.md 骨架落盘并提交。
- 门 2 已批准(2026-10-16):spec 用例详版 + plan.md 任务计划获批。

## 交付物

- `extensions/llm-wiring.ts` + `.test.ts` — 会话模型 → cs provider 注入;25 契约测试。
- `extensions/scan-runner.ts` + `.test.ts` — 扫描进程后台生命周期、双层产物目录、fd 直传 stdio;22 契约测试。
- `extensions/findings-parser.ts` + `.test.ts` — 扫描产物 → 严重级别摘要;9 契约测试。
- `extensions/run-executor.ts` + `.test.ts` — cs 子命令白名单透传、截断、超时;14 契约测试。
- `extensions/index.ts` + `.test.ts` — 装配 3 工具 + `/security-scan` 命令 + 完成通知;16 契约测试。
- `skills/codex-security-scan/SKILL.md` — 触发路由 + cs 全部 24 子命令参考 + 三级安全纪律。
- `package.json` — pi 包声明(`pi install ./` 即装)。
- `docs/plans/2026-10-16-pi-codex-security/` — design.md / spec.md(84 条变更记录)/ plan.md。
- `docs/adr/0001-*.md`、`0002-*.md` — 两条难逆转决策记录。
- `CONTEXT.md` — 9 条领域词汇。

## 进行中事项

- (无阻塞项)

## 待确认

- ~~GLM 对 Codex effort 档位兼容性~~ → 已验证(2026-10-16):真实 GLM-5.3 接受默认 `xhigh`,token 流正常无拒绝。
- ~~Windows 下 cs `.cmd` 垫片与 detached 进程行为~~ → 已验证(2026-10-16):垫片解析直 spawn 保真 argv;detached+fd 直传 stdio,父进程退出后子进程日志仍完整(守卫测试钉住)。
- **遗留(非阻塞)**:无。Windows 真实扫描三道环境拦截(auth 预检 / credential-home ACL / `--max-cost` 计量)已于 `c54b0b7` 实验固化解决。
## 最近完成

- 2026-10-16 05:13 设计访谈与门 1:完成 dev 重流程阶段 1 访谈(模型跟随语义、全覆盖范围、凭证传递、后台+通知等 14 项决策收敛),写 design.md、spec.md 骨架、CONTEXT.md(10 词条)、ADR-0001/0002,用户批准门 1。验证方式:design-checklist 逐条自查通过,呈报文档用户确认。
- 2026-10-19 05:08 门 3 交付确认:全部 5 任务(llm-wiring / scan-runner / findings-parser / index 装配 / SKILL.md + Gate)完成并提交,独立评审每任务通过,86 测试全绿,pi `pi -e ./` 加载正常,三工具 + `/security-scan` 命令注册齐全,SKILL.md 覆盖 cs 全部 24 子命令与三级安全纪律。验证方式:`node --test extensions/*.test.ts` 86/86、`pi --print -e ./extensions/index.ts` 工具枚举、`--mock` 全链路、`--dry-run` 命令模板、真实 GLM-5.3 扫描 token 流、密钥零泄漏双 grep。
- 2026-10-19 05:08 Gate B 真实扫描环境三拦截实验固化(`c54b0b7`):`--auth api-key` + 占位 `OPENAI_API_KEY` 过 cs auth 预检;win32 子进程 `TEMP`/`TMP` 重定向至 `<csState>/tmp-cred`(无 `Users` 组写权限)解除 credential-home ACL 拦截;`--max-cost` 对第三方模型不可计量弃用(控费靠最小目标)。验证方式:TEMP 重定向后 ACL 拦截解除、`--auth` 后预检通过、真实 GLM-5.3 token 流持续滚动无 xhigh 拒绝。
- 2026-10-19 13:5x 门 3 后缺陷修复(`38be087`):用户真实会话 + Gate D 实测暴露三缺陷——scope 被模型字符串化(prepareArguments shim)、run 工具裸 env 无 win32 修复(executeRun 走 buildChildEnv + scan 自动补 --auth)、api.getModel 不存在(改 ctx.model 属性取法)。验证方式:91 测试全绿、mutation ×4 全红还原、Gate D 真实模型调用实测通过(校验通过、execute 真跑、错误按 ADR-0001 语义映射)。
- 2026-10-19 07:20 门 3 后缺陷修复 D(`2fe4583`):mimo 网关真实扫描 preflight 被拒(web_search 工具不受支持)——cs 四辅助线程全禁 web_search 而扫描主线程不禁(cs 0.3.0 源码核证),本包 buildWiring 注入 `--codex web_search="disabled"` + run 工具 scan 命令同步自动补(用户显式覆盖时不重复注入)。验证方式:92 测试全绿、mutation ×2 全红还原、mock 扫描实测 cs 接受该覆盖(exit 0);真实网关验证待用户重跑。
- 2026-10-19 07:39 web_search 修复真实网关验证 + Windows 沙箱环境冲突诊断:用户重跑真实扫描,web_search 报错消失(修复生效),新失败点为 codex Windows 沙箱 setup refresh——沙箱日志铁证 `runtime read/execute validation failed ... VCRUNTIME140_1.dll ... os error 32`:Codex 桌面版 cua 运行时 DLL 被桌面进程锁定,属上游已知 bug(openai/codex#52116/#54325),与 cs/本包无关;裸 codex sandbox 复现并在桌面进程退出后自愈。处置:SKILL.md 解读纪律补已知环境故障条目(症状/根因/处置);包代码零改动。

## 待办

- (无。dev 重流程门 3 已交付,全部任务完成;后续如需扩展,可另起新计划。)
