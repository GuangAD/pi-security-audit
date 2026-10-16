# pi-codex-security 包开发计划

> 设计依据:./design.md(已批准);实现规格:./spec.md(已批准,含接口组与用例表)
> 状态:已批准(门 2,2026-10-16;全部完成后改为:已完成)

## 全局约束

从 design.md「技术栈与依赖约束」节继承,每个任务隐式遵守:

- TypeScript 由 pi 的 jiti 直接运行,不设编译步骤、不设 build 脚本。
- 零第三方 npm 依赖:进程用 `node:child_process`,文件用 `node:fs`,schema 用宿主提供的 `typebox`。
- peerDependencies 声明宿主包(`@earendil-works/pi-coding-agent`、`typebox`),range `"*"`,不进 dependencies、不打包。
- 外部运行时依赖:cs CLI ≥ 0.3.0 在 PATH;缺失时工具返回可读错误,不尝试安装。
- 目标平台:Windows / macOS / Linux;路径拼接一律 `node:path`,不手拼分隔符。
- 密钥红线:API key 只存在于进程环境变量传递链,禁止出现在命令行参数、日志、落盘文件、错误消息。
- 扫描产物统一用 cs 默认 state dir,本包不重定向 `--output-dir`。
- 测试框架:node:test(零依赖),测试文件 `extensions/*.test.ts`;测试环境为本机 Node v24(原生 TS 运行)。

TDD waiver 预登记:

- 任务 5(SKILL.md 文档 + package.json 收尾):纯文档与配置,无行为代码。验收替代:Gate B/C 机检 + spec「非 seam 模块与视觉验收」目测清单逐条。

## 任务清单

<!-- 进度标记:完成一个勾一个并回填 commit 短哈希;恢复时从第一个未勾选处继续 -->

- [x] 任务 1:llm-wiring——LLM 接线模块(commit: 6eb838a )
- [x] 任务 2:scan-runner——扫描进程生命周期(commit: f3f1b73 )
- [x] 任务 3:findings-parser——产物解析摘要(commit: 13f7fbd )
- [ ] 任务 4:run-executor + index 装配——工具层与包骨架(commit: ____ )
- [ ] 任务 5:SKILL.md + Gate A/B/C 验证(commit: ____ )

## 任务详情

### 任务 1:llm-wiring——LLM 接线模块

- **端到端行为**:给定会话模型描述与凭证环境,产出 cs 可用的 `--codex` 注入参数与环境变量;协议不兼容或凭证缺失时产出结构化错误;`cs scan --dry-run` 带注入参数可被 cs 正确解析(Gate A)。
- **涉及**:
  - 新建 `extensions/llm-wiring.ts`(resolveLlmWiring、loadOverrides、PROTOCOL_ENDPOINT_MAP、内部 resolveAgentDir/tomlValue)
  - 新建 `extensions/llm-wiring.test.ts`
- **编码方向**:spec「编码方向 → extensions/llm-wiring.ts」三条 + 已知的坑(auth.json 内部格式、GLM effort 档位 Gate A 实测)。
- **接口组**:`llm-wiring.resolveLlmWiring`、`llm-wiring.loadOverrides`(从红到绿);消费非 seam `PROTOCOL_ENDPOINT_MAP`。
- **数据结构落地**:LlmWiring、LlmWiringError、CsOverrideConfig(spec 数据结构说明节)。
- **验收标准**:
  - [ ] 机检:`node --test extensions/llm-wiring.test.ts` 全绿,覆盖 spec 全部用例表行 + 覆盖声明(11 行矩阵、2 条铁律、7 值枚举)。
  - [ ] 机检:密钥脱敏铁律——全矩阵行序列化输出不含 `TESTKEY_SENTINEL_12345`(字符串断言)。
  - [ ] 机检:Gate A——用真实接线参数构造 `cs scan . --dry-run --codex ... --model glm-5.3` 在本机执行,cs 参数解析无报错(退出码 0 或 dry-run 预期输出);`--mock` 跑一次合成扫描确认产物生成;GLM effort 档位接受性结论写入开发记录,拒绝则降档固化。
  - [ ] 目测:错误对象 detail 含补救指引且无密钥。
- **依赖**:无。

### 任务 2:scan-runner——扫描进程生命周期

- **端到端行为**:对合法 git 仓库发起扫描,后台 spawn 立即返回句柄;状态查询四态正确;会话重启后凭 state.json 恢复查询;并发第 3 个被拒;shutdown 不杀扫描进程。
- **涉及**:
  - 新建 `extensions/scan-runner.ts`(startScan、getScanStatus、activeScans)
  - 新建 `extensions/scan-runner.test.ts`
- **编码方向**:spec「编码方向 → extensions/scan-runner.ts」四条 + 已知的坑(Windows .cmd 垫片、--output-dir、--diff 预检)。
- **接口组**:`scan-runner.startScan`、`scan-runner.getScanStatus`;消费非 seam `activeScans`。
- **数据结构落地**:ScanParams、ScanHandle、ScanStatus、ScanStateFile(spec 数据结构说明节)。
- **验收标准**:
  - [ ] 机检:`node --test extensions/scan-runner.test.ts` 全绿,覆盖用例表 + 6 组合枚举 + 铁律(args 可逆拼装、产物无 key 哨兵)。
  - [ ] 机检:数值预算——并发 ≤ 2(第 3 次断言)、logTail ≤ 8KB(1MB 日志断言)。
  - [ ] 目测:state.json 内容与 ScanStateFile 一致,commandRedacted 无明文 key。
- **依赖**:任务 1 的 `LlmWiring` 类型(startScan 签名消费 wiring)。

### 任务 3:findings-parser——产物解析摘要

- **端到端行为**:对含 findings.json 的产物目录产出严重级别计数与 top 发现;产物缺损时降级不抛;计数守恒。
- **涉及**:
  - 新建 `extensions/findings-parser.ts`(summarizeFindings)
  - 新建 `extensions/findings-parser.test.ts`
- **编码方向**:spec「编码方向 → extensions/findings-parser.ts」两条。
- **接口组**:`findings-parser.summarizeFindings`。
- **数据结构落地**:FindingSummary(spec 数据结构说明节)。
- **验收标准**:
  - [ ] 机检:`node --test extensions/findings-parser.test.ts` 全绿,覆盖用例表 + 守恒铁律(counts 和 == fixture 条数)+ round-trip 自洽。
  - [ ] 机检:数值预算——topFindings ≤ 10 且 severity 降序(15 条 fixture 断言)。
  - [ ] 目测:降级结果含 reportPath,无假状态。
- **依赖**:无硬依赖(读 cs 产物格式,与任务 2 产物目录约定软耦合;推荐顺序:任务 2 后)。

### 任务 4:run-executor + index 装配——工具层与包骨架

- **端到端行为**:`pi -e ./` 加载无报错,3 工具 + `/security-scan` 命令注册齐全;run 工具白名单/截断/超时行为正确;scan/status 工具错误映射到 isError;完成通知经 sendUserMessage 接线;session_shutdown 清理注册表。
- **涉及**:
  - 新建 `extensions/run-executor.ts`(executeRun、CS_SUBCOMMAND_WHITELIST)
  - 新建 `extensions/run-executor.test.ts`
  - 新建 `extensions/index.ts`(扩展工厂:3 工具注册、命令、完成通知、session_shutdown)
  - 新建 `package.json`(pi 包声明,peerDependencies)
- **编码方向**:spec「接口面穷举清单」模块职责;`spawn` 前台执行继承 cwd;TypeBox schema 与数据结构对齐。
- **接口组**:`run-executor.executeRun`、`index` 工具三 execute(scan/status/run);消费任务 1-3 全部 seam。
- **数据结构落地**:ScanParams(工具入参 schema)、结构化返回(ScanHandle/ScanStatus/RunResult)。
- **验收标准**:
  - [ ] 机检:`node --test extensions/run-executor.test.ts` 全绿,覆盖用例表 + 白名单枚举对拍(22 子命令恰好 3 拒绝)+ 数值预算(50KB 截断、超时杀进程)。
  - [ ] 机检:`pi -e ./` 加载无报错(退出码 0,stderr 无 extension error)。
  - [ ] 机检:错误映射枚举——全部 error reason 逐一断言 isError 且 detail 非空。
  - [ ] 目测:工具 schema 与 spec 数据结构字段一致。
- **依赖**:任务 1 的 `resolveLlmWiring`、任务 2 的 `startScan`/`getScanStatus`、任务 3 的 `summarizeFindings`(硬依赖,全部)。

### 任务 5:SKILL.md + Gate A/B/C 验证

- **端到端行为**:自然语言「安全扫描当前分支」经 skill 路由到工具;全命令参考可查;扫描完成通知触发解读且汇报符合纪律;三个 Gate 通过,记录落盘。
- **涉及**:
  - 新建 `skills/codex-security-scan/SKILL.md`
  - package.json skills 声明核对(如任务 4 已覆盖则只验收)
  - Gate A/B/C 验证记录写入 ROADMAP.md「最近验证」
- **编码方向**:spec「非 seam 模块与视觉验收」目测清单逐条;解读纪律(只读汇报、以 report.md 为准);官方 skills 提醒规则;跨会话边界说明。
- **接口组**:无(纯文档)。消费全部已实现工具。
- **数据结构落地**:无。
- **验收标准**:
  - [ ] 机检:Gate B——`pi -e ./` 后小范围真实扫描(--path 一个小目录,--max-cost 或最小目标控费)→ status 轮询到 completed → structuredContent 与 report.md 解读全链路;产物位置与 state.json 符合 spec。
  - [ ] 机检:Gate C——自然语言「安全扫描一下当前分支」正确路由到 skill 场景,触发 codex_security_scan;汇报格式符合解读纪律(目测)。
  - [ ] 目测:spec「非 seam 模块与视觉验收」6 条逐条过。
  - [ ] 目测:密钥扫描(grep 扩展、skill、日志、配置零明文 key)。
  - [ ] 机检:`pi install ./` 后 `pi list` 可见包(Gate B 一部分)。
  - [ ] 机检:Gate A 结论复核(GLM effort 档位结论已在任务 1 开发记录;此处确认固化值与命令模板一致)。
- **依赖**:任务 4 的工具层(硬依赖)。
- **备注**:Gate B 真实扫描产生少量 GLM 积分消耗(最小目标);若 cs `--mock` 产物已覆盖解析链路,真实扫描只做一次冒烟。

## 开发记录

- 任务 1 | 完成 | commit 6eb838a
  - BASE:73aff41
  - 评审:reviewer 独立评审放行,3 Minor 记录在案(auth.json 条目不校验 type 字段;映射按主机名不校验路径,spec 固有语义;铁律1矩阵少 2 个构造组合,实质充分)。首次 reviewer 派发 30 分钟超时被杀(默认模型过慢),重试用 glm-5.3-flash:low + 收窄阅读范围成功——后续任务派评审直接带此经验。
  - waiver:批 F 覆盖声明类测试(枚举/铁律)基于已实现行为首跑即绿,属性质测试而非缺陷复现,未补造红态;与 TDD vertical slice 纪律一致性由 controller 认可。
  - 变更记录:已登记(modelOverride 用例验收归属移至任务 4)
  - 结论:
    1. Gate A 固化命令模板:cs scan <repo> --headless --codex model_provider="<p>" --codex model_providers.<p>.{base_url,wire_api="responses",env_key}=... --model <id>;key 只经 env;--effort 不进 codexArgs,GLM 对 xhigh 的 LLM 侧接受性留任务 5 Gate B 确认,拒绝则命令层 --effort high 降档。
    2. index.ts 装配只需 resolveLlmWiring(pi.getModel(), loadOverrides()),错误 detail 原样呈现即满足契约;测试 harness(agent-dir mock、凭证 env 存取、TOML 逆解析器)可复制给任务 3/4。
    3. pi-ai Api 七值枚举已验证每值恰命中直连/映射/报错之一,新增协议值静默漏判有测试兜底。
- 任务 2 | 完成 | commit f3f1b73
  - BASE:08138a3(中途两次设计精确回退修订:adfef3a 产物路径、876d81e 双层目录+detail,均已用户/权限内裁决并登记 spec 变更记录)
  - 评审:reviewer 独立评审「修复后放行」——Important 1 条(stdio 管道威胁跨会话存活契约)+ Minor 5 条(summary 字段归属任务 4;脱敏双保险对含引号 env 值失效;createScanDir TOCTOU;测试 trackedChildren 死代码;死 pid 复用窗口假设)。Important 已修(fd 直传 stdio)+ 守卫用例 + mutation check(回退管道版守卫转红,还原绿),收窄复审通过无必修项。
  - 实现形态说明:implementer 两次 30 分钟超时(第一次全部预算耗在实证研究;第二次落盘后仍有 9 红),controller 按 fallback 会话内收尾:修复 3 处测试 bug(fixture 垫片 \\f 转义、真实 cs.cmd 测试 PATH 剥离、铁律1 前缀断言口径)+ 补写 getScanStatus 整组测试(6 条)+ Important 修复。生产代码 scan-runner.ts 主体出自 implementer。
  - 结论:
    1. cs 启动一律走垫片解析直 spawn(win32):shell:true 会吃 --codex TOML 引号,已在首份简报实测固化;parseNpmShimEntry 对真实 npm 形态(`%dp0%\...` 带显式反斜杠)解析,fixture 同形态。
    2. 产物双层:scanDir 根落 state.json+scan.log,artifacts/ 空目录经 --output-dir 传 cs(cs 拒绝非空 --output-dir,exit 2);getScanStatus 的 report.md 判定走 <scanDir>/artifacts/report.md。
    3. 跨会话契约的实现要点:stdio 直传 fd(非管道)、detached+unref、pid 落盘、session_shutdown 只清注册表——守卫测试已钉住「父进程退出后子进程日志仍完整」。
    4. 假 cs fixture 模式(PATH 前置垫片 + 捕获 argv JSON + FAKE_CS_* 环境变量族)已成体系,任务 4 的 run-executor 测试可直接复用。
- 任务 3 | 完成 | commit 13f7fbd
  - BASE:cf83127
  - 评审:reviewer 独立评审「放行」,3 Minor 记录在案(locationText 无对象键条目返空;解析失败静默吞错无日志;pinned 3 冗余断言)。
  - 变更记录:已登记(summarizeFindings 签名扩展可注入 csFindingsProvider;source="report-md" 成功路径不可达的裁决)。
  - 结论:
    1. findings.json 真实格式:顶层 {documentType, findings, scanId, schemaVersion},severity/confidence 均为嵌套对象 {level: ...};实现按此提取,未知 level 宁缺勿错。
    2. 任务 4 装配层注入真实 cs findings --json 包装即可走第一级;不传 opts 即手解析默认路径,二者共用 summarizeFindingsDoc 摘要逻辑;status 工具对 report.md 只能经 degraded.reportPath 呈现,不会有 source="report-md" 的 summary。
    3. 排序稳定性靠显式次关键字(原序下标),不依赖引擎 sort 稳定性。
