/**
 * extensions/findings-parser.test.ts — summarizeFindings 机检
 *
 * 事实源:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/findings-parser.ts」节
 * (pinned case 用例表 5 条、覆盖声明[守恒铁律 + round-trip 自洽]、数值预算 topFindings ≤ 10)。
 * 期望值全部为独立构造的字面量(计数、顺序、路径、fixture 条数),不用被测代码的算法重算。
 *
 * hermetic:静态 fixture + 真实临时目录(只读操作),不 spawn 任何进程;
 * 降级路径用真实 fs(不 mock),fixture 构造即真实产物双层结构 <scanDir>/artifacts/<file>。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  summarizeFindings,
  type FindingSummary,
  type DegradedFindings,
} from "./findings-parser.ts";

// —— 测试环境:临时产物目录(用例内创建,after 统一清理) ——

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 构造产物目录双层结构 <scanDir>/artifacts/<file>(任务 2 固化约定),纯静态 fixture */
function makeScanDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findings-parser-test-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "artifacts", name), content);
  }
  return dir;
}

/** findings.json 文本:真实顶层结构(documentType/findings/scanId/schemaVersion) */
function findingsDoc(findings: unknown[]): string {
  return JSON.stringify({
    documentType: "findings",
    findings,
    scanId: "fixture-scan",
    schemaVersion: "1",
  });
}

/**
 * 真实格式 finding 条目(已验证事实:severity/confidence 为嵌套 { level } 对象,
 * locations 为数组,codeEvidence 为字符串)。参数为 null 表示该字段整体缺失(容错用例)。
 */
function makeFinding(
  severity: string | null,
  locations: unknown[] | null,
  evidence: string | null,
  confidence: string | null = "high",
): Record<string, unknown> {
  const entry: Record<string, unknown> = { findingId: "F000", title: "fixture finding" };
  if (severity !== null) entry.severity = { level: severity };
  if (locations !== null) entry.locations = locations;
  if (evidence !== null) entry.codeEvidence = evidence;
  if (confidence !== null) entry.confidence = { level: confidence, rationale: "fixture rationale" };
  return entry;
}

/** 断言结果为摘要形态(非 degraded),并返回可用字段 */
function expectSummary(result: FindingSummary | DegradedFindings): FindingSummary {
  assert.ok(
    !("degraded" in result),
    `expect summary, got degraded: ${JSON.stringify(result)}`,
  );
  return result;
}

/** 断言结果为降级形态,并返回可用字段 */
function expectDegraded(result: FindingSummary | DegradedFindings): DegradedFindings {
  assert.ok(
    "degraded" in result && result.degraded === true,
    `expect degraded, got: ${JSON.stringify(result)}`,
  );
  return result;
}

/** 机检铁律 2:返回对象 JSON.stringify → parse round-trip 深等(结构自洽) */
function assertRoundTrip(value: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

// —— fixture:critical 1、high 2、medium 3、low 0(pinned case 1 输入,已按降序排列) ——

const FINDINGS_T1 = [
  makeFinding("critical", [{ path: "src/auth.ts", line: 12 }], "critical evidence", "high"),
  makeFinding("high", [{ path: "src/a.ts" }], "high evidence 1", "medium"),
  makeFinding("high", [{ path: "src/b.ts" }], "high evidence 2", null),
  makeFinding("medium", [{ path: "src/c.ts" }], "medium evidence 1", "high"),
  makeFinding("medium", [{ path: "src/d.ts" }], "medium evidence 2", "high"),
  makeFinding("medium", [{ path: "src/e.ts" }], "medium evidence 3", "high"),
];

// pinned case 1:计数精确
test("pinned 1:计数精确,source findings-json,守恒铁律 + round-trip", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T1) });
  const summary = expectSummary(await summarizeFindings(dir));

  // 期望值独立字面量(手数 fixture:critical 1、high 2、medium 3、low 0)
  assert.deepEqual(summary.counts, { critical: 1, high: 2, medium: 3, low: 0 });
  // 后置条件:counts 四级别键齐备
  assert.deepEqual(Object.keys(summary.counts).sort(), ["critical", "high", "low", "medium"]);
  assert.equal(summary.source, "findings-json");
  assert.equal(summary.topFindings.length, 6);

  // 机检铁律 1:counts 各级之和 == fixture 条数(oracle = 输入数组长度,独立于实现逻辑)
  const total =
    summary.counts.critical +
    summary.counts.high +
    summary.counts.medium +
    summary.counts.low;
  assert.equal(total, FINDINGS_T1.length); // fixture 手数 = 6

  // 机检铁律 2:JSON round-trip 深等
  assertRoundTrip(summary);
});

// pinned case 5:三源全缺(provider 缺省、findings.json 缺失、report.md 缺失)
test("pinned 5:空目录返回 { degraded, reportPath: null },不抛", async () => {
  const dir = makeScanDir({});
  const degraded = expectDegraded(await summarizeFindings(dir));

  assert.equal(degraded.reportPath, null);
  assertRoundTrip(degraded);
});

// pinned case 2:仅 report.md 存在 → degraded 且 reportPath 非 null(降级不抛,无假状态)
test("pinned 2:仅 report.md 存在返回 degraded,reportPath 为绝对路径", async () => {
  const dir = makeScanDir({ "report.md": "# fixture report\nany text\n" });
  const degraded = expectDegraded(await summarizeFindings(dir));

  assert.equal(degraded.reportPath, path.resolve(dir, "artifacts", "report.md"));
  // 无假状态:降级对象不含摘要字段
  assert.ok(!("counts" in degraded));
  assert.ok(!("topFindings" in degraded));
  assert.ok(!("source" in degraded));
  assertRoundTrip(degraded);
});

// controller 裁决:findings.json 不可解析但 report.md 在 → 降级,不返回伪 summary
test("裁决:findings.json 损坏 + report.md 在 → degraded(reportPath 非 null),不臆造 summary", async () => {
  const dir = makeScanDir({
    "findings.json": "not-json{{{",
    "report.md": "# fixture report\nany text\n",
  });
  const degraded = expectDegraded(await summarizeFindings(dir));

  assert.equal(degraded.reportPath, path.resolve(dir, "artifacts", "report.md"));
  assert.ok(!("counts" in degraded));
  assertRoundTrip(degraded);
});

// —— fixture:15 条 severity 混序(pinned case 3 / 数值预算 topFindings ≤ 10 输入) ——

const SEVERITIES_T3 = [
  "medium", "critical", "high", "medium", "low",
  "high", "critical", "medium", "high", "low",
  "critical", "high", "medium", "critical", "high",
] as const;

const FINDINGS_T3 = SEVERITIES_T3.map((severity, i) =>
  makeFinding(severity, [{ path: `f${i}.ts` }], `evidence ${i}`, "high"),
);

// pinned case 3 + 数值预算:返回 10 条、severity 降序、同级保持 fixture 原序稳定
test("pinned 3:15 条混序 → topFindings 10 条,severity 降序且同级稳定", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T3) });
  const summary = expectSummary(await summarizeFindings(dir));

  // 数值预算:≤ 10(字面量 10,独立于实现常量)
  assert.equal(summary.topFindings.length, 10);
  assert.ok(summary.topFindings.length <= 10);

  // 期望值独立字面量:逐条手数 SEVERITIES_T3 —— critical 下标 1,6,10,13 = 4;
  // high 下标 2,5,8,11,14 = 5;medium 下标 0,3,7,12 = 4;low 下标 4,9 = 2(合计 15)
  assert.deepEqual(summary.counts, { critical: 4, high: 5, medium: 4, low: 2 });
  // 截断后前 10 = 4 critical + 5 high + 第一条 medium(下标 0)
  assert.deepEqual(
    summary.topFindings.map((f) => f.severity),
    [
      "critical", "critical", "critical", "critical",
      "high", "high", "high", "high", "high",
      "medium",
    ],
  );
  // 同级稳定序:critical 按原序 1,6,10,13;high 按原序 2,5,8,11,14;medium 首条 0
  assert.deepEqual(
    summary.topFindings.map((f) => f.location),
    [
      "f1.ts", "f6.ts", "f10.ts", "f13.ts",
      "f2.ts", "f5.ts", "f8.ts", "f11.ts", "f14.ts",
      "f0.ts",
    ],
  );

  // 机检铁律 1:counts 和 == fixture 条数(oracle = 输入数组长度,独立于实现)
  const total =
    summary.counts.critical +
    summary.counts.high +
    summary.counts.medium +
    summary.counts.low;
  assert.equal(total, FINDINGS_T3.length); // fixture 手数 = 15

  // 机检铁律 2:JSON round-trip 深等
  assertRoundTrip(summary);
});

// —— fixture:字段缺失 + 未知 level(pinned case 4 输入) ——

const FINDINGS_T4 = [
  makeFinding("critical", [{ path: "k0.ts" }], "k0 evidence", "high"), // 完整条目
  makeFinding(null, [{ path: "k1.ts" }], "k1 evidence", "high"), // 缺 severity → 不计数不入 top
  makeFinding("info", [{ path: "k2.ts" }], "k2 evidence", "high"), // 未知 level → 不计数不入 top
  makeFinding("medium", [{ path: "k3.ts" }], null, "high"), // 缺 codeEvidence → evidence ""
  makeFinding("high", null, "k4 evidence", null), // 缺 locations → location "";缺 confidence → 键不出现
];

// pinned case 4:字段缺失容错(不抛、缺失按空/0、不臆造、未知 level 宁缺勿错)
test("pinned 4:字段缺失与未知 level 不抛,缺失按空/0,info 不入计数与 top", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T4) });
  const summary = expectSummary(await summarizeFindings(dir));

  // 期望值独立字面量:手数 fixture 四级已知条目 = 3(critical/medium/high 各 1;
  // 缺 severity 的 k1 与 info 的 k2 不计)
  assert.deepEqual(summary.counts, { critical: 1, high: 1, medium: 1, low: 0 });
  assert.equal(
    summary.counts.critical +
      summary.counts.high +
      summary.counts.medium +
      summary.counts.low,
    3, // oracle = 手数 T4 fixture 四级已知条数(5 条中 3 条)
  );

  // 未知/缺失 severity 不入 top(宁缺勿错);top 顺序按 severity 降序
  // (k4 无 locations → location 空串)
  assert.deepEqual(
    summary.topFindings.map((f) => f.location),
    ["k0.ts", "", "k3.ts"],
  );
  // counts 键域仅四级,不臆造 "info" 等键
  assert.ok(!("info" in summary.counts));

  // 缺失字段按空/缺省,不臆造:evidence 空串、location 空串、confidence 键不出现
  const mediumFinding = summary.topFindings.find((f) => f.location === "k3.ts");
  assert.ok(mediumFinding);
  assert.equal(mediumFinding.evidence, "");
  const highFinding = summary.topFindings.find((f) => f.severity === "high");
  assert.ok(highFinding);
  assert.equal(highFinding.location, "");
  assert.ok(!("confidence" in highFinding));

  assertRoundTrip(summary);
});

// —— 解析优先级第一级:cs findings --json 可注入 provider(spec 编码方向 1) ——

// 桩返回空 findings(0 条)与文件 fixture(critical 1)可区分 → 证明第一级优先
test("provider:第一级优先,桩返回空 findings → counts 全 0,桩恰调用一次", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T1) });
  let providerCalls = 0;
  const summary = expectSummary(
    await summarizeFindings(dir, {
      csFindingsProvider: async () => {
        providerCalls += 1;
        return { documentType: "findings", findings: [], scanId: "stub" };
      },
    }),
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(summary.counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(summary.topFindings.length, 0);
  assert.equal(summary.source, "findings-json");
});

// 桩抛错 → 第一级失败,降级第二级手解析 findings.json(优先级次序)
test("provider:桩抛错 → 降级手解析文件,取 fixture counts", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T1) });
  let providerCalls = 0;
  const summary = expectSummary(
    await summarizeFindings(dir, {
      csFindingsProvider: async () => {
        providerCalls += 1;
        throw new Error("stub cs findings failure");
      },
    }),
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(summary.counts, { critical: 1, high: 2, medium: 3, low: 0 });
  assert.equal(summary.source, "findings-json");
});

// 桩返回无效形状(非 findings 文档)→ 不抛,降级手解析文件
test("provider:桩返回无效形状 → 不抛,降级手解析文件", async () => {
  const dir = makeScanDir({ "findings.json": findingsDoc(FINDINGS_T1) });
  let providerCalls = 0;
  const summary = expectSummary(
    await summarizeFindings(dir, {
      csFindingsProvider: async () => {
        providerCalls += 1;
        return 42;
      },
    }),
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(summary.counts, { critical: 1, high: 2, medium: 3, low: 0 });
});
