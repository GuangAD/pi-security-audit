/** artifact-validator 契约测试(spec:validateFindings 7 例 + validateCoverage 3 例 + 覆盖声明) */
import assert from "node:assert/strict";
import { test } from "node:test";
import os from 'node:os';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SchemaLoadError,
  validateAgainstSchema,
  validateCoverage,
  validateFindings,
} from "./artifact-validator.ts";

const SCHEMAS = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "schemas");
const FINDINGS_SCHEMA = path.join(SCHEMAS, "findings.schema.json");
const COVERAGE_SCHEMA = path.join(SCHEMAS, "coverage.schema.json");

/** 构造一个满足 findings.schema 必填与 pattern 的最小合法 finding(cs 原版 schema 为事实源) */
function minFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const hex24 = "aabbccddeeff001122334455";
  const hex64 = "aabbccddeeff001122334455aabbccddeeff001122334455aabbccddeeff0011";
  return {
    findingId: `csf_${hex24}`,
    occurrenceId: `occ_${hex24}`,
    ruleId: "hardcoded-secret",
    identity: { anchor: "src/db.js" },
    fingerprints: { algorithm: "codex-security/v1", primary: `codex-security/v1:sha256:${hex64}` },
    title: "硬编码密钥",
    summary: "数据库连接串内嵌 API key。",
    severity: { level: "high" },
    confidence: { level: "high", rationale: "证据直接可见" },
    taxonomy: { category: "credential-exposure", cwe: ["CWE-798"] },
    locations: [{ path: "src/db.js", startLine: 10 }],
    remediation: "改用环境变量注入密钥。",
    provenance: { source: "baseline" },
    ...overrides,
  };
}

function minFindingsDoc(findings: unknown[]): Record<string, unknown> {
  return { documentType: "codex-security.findings", schemaVersion: "1.0", scanId: "scan-001", findings };
}

/** 构造最小合法 coverage 文档(必填 11 项) */
function minCoverageDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentType: "codex-security.coverage",
    schemaVersion: "1.0",
    scanId: "scan-001",
    mode: "scoped_path",
    inventoryStrategy: "custom",
    includePaths: [],
    excludePaths: [],
    surfaces: [{ id: "s1", label: "src/", disposition: "reported", receiptRefs: [] }],
    explicitExclusions: [],
    deferred: [],
    ...overrides,
  };
}

// —— validateFindings 用例详版(spec 7 例) ——

test("F1 合法最小文档通过", () => {
  const r = validateFindings(minFindingsDoc([minFinding()]));
  assert.deepEqual(r, { ok: true });
});

test("F2 缺必填字段报错:findings[0] 缺 severity → 错误路径含 severity", () => {
  const f = minFinding();
  delete (f as Record<string, unknown>).severity;
  const r = validateFindings(minFindingsDoc([f]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("severity")));
});

test("F3 枚举外 severity.level 报错:catastrophic 不在枚举", () => {
  const f = minFinding({ severity: { level: "catastrophic" } });
  const r = validateFindings(minFindingsDoc([f]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("severity") && /枚举/.test(e.message)));
});

test("F4 非对象文档报错:字符串与数组均拦", () => {
  for (const doc of ["string", [1, 2]]) {
    const r = validateFindings(doc);
    assert.equal(r.ok, false, `${typeof doc} 应被拦`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.path === "$"));
  }
});

test("F5 嵌套 $ref 生效:locations 缺必填子字段 → 错误指向嵌套路径", () => {
  const f = minFinding({ locations: [{ path: "a.js" }] }); // 缺 startLine
  const r = validateFindings(minFindingsDoc([f]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("startLine")));
});

test("F6 多项错误精确定位:findings[1] 缺 title → 路径含 [1]", () => {
  const f1 = minFinding();
  const f2 = minFinding();
  delete (f2 as Record<string, unknown>).title;
  const r = validateFindings(minFindingsDoc([f1, f2]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("[1]") && e.path.includes("title")));
});

test("F7 schemaPath 缺失抛 SchemaLoadError", () => {
  assert.throws(() => validateAgainstSchema({}, path.join(SCHEMAS, "nope.schema.json")), SchemaLoadError);
});

test("F 附:findingId pattern 违规(非 csf_ 前缀)被 pattern 拦截", () => {
  const f = minFinding({ findingId: "xxx_000000000000000000000000" });
  const r = validateFindings(minFindingsDoc([f]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("findingId")));
});

// —— 覆盖声明:required 逐删遍历(13 字段程序化) ——

test("覆盖声明:finding 13 个必填字段逐个删除 → 每次都 ok:false 且错误指向该字段", () => {
  const REQUIRED = [
    "findingId", "occurrenceId", "ruleId", "identity", "fingerprints", "title",
    "summary", "severity", "confidence", "taxonomy", "locations", "remediation", "provenance",
  ];
  const schema = JSON.parse(fs.readFileSync(FINDINGS_SCHEMA, "utf8"));
  const schemaRequired = (schema.properties.findings.items.required as string[]).sort().join(",");
  assert.equal(REQUIRED.sort().join(","), schemaRequired, "测试清单与 cs schema required 同步");
  for (const field of REQUIRED) {
    const f = minFinding();
    delete (f as Record<string, unknown>)[field];
    const r = validateFindings(minFindingsDoc([f]));
    assert.ok(r.ok === false, `删除 ${field} 后必须失败`);
    if (!r.ok) {
      assert.ok(
        r.errors.some((e) => e.path.includes(field)),
        `删除 ${field} 的错误必须指向 ${field},实际:${JSON.stringify(r.errors)}`,
      );
    }
  }
});

test("覆盖声明:severity.level 枚举全值(5 合法全过 + 非法全拦)", () => {
  for (const level of ["critical", "high", "medium", "low", "informational"]) {
    const r = validateFindings(minFindingsDoc([minFinding({ severity: { level } })]));
    assert.ok(r.ok, `合法枚举 ${level} 不应被拦`);
  }
  for (const level of ["catastrophic", "BLOCKER"]) {
    const r = validateFindings(minFindingsDoc([minFinding({ severity: { level } })]));
    assert.ok(r.ok === false, `非法枚举 ${level} 必须被拦`);
  }
});

test("覆盖声明:真实 cs schema 锚点——校验器加载并应用原版 $defs/$ref 结构", () => {
  // loadSchema + validateAgainstSchema 直用原版文件(不经包装函数),证明子集校验器读懂真实 schema
  const doc = minFindingsDoc([minFinding()]);
  const r = validateAgainstSchema(doc, FINDINGS_SCHEMA);
  assert.deepEqual(r, { ok: true });
});

test("F 附:const 违规拦截(documentType 错值)", () => {
  const doc = minFindingsDoc([minFinding()]);
  doc.documentType = "coverage"; // 正确值是 codex-security.findings
  const r = validateFindings(doc);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("documentType") && /常量/.test(e.message)));
});

test("C 附:receiptRefs 接受 checkpoints/ 路径,拦截 ../ 穿越", () => {
  const okDoc = minCoverageDoc({
    surfaces: [{ id: "s1", label: "x", disposition: "reported", receiptRefs: ["checkpoints/validations/c1.json"] }],
  });
  assert.deepEqual(validateCoverage(okDoc), { ok: true });
  const badDoc = minCoverageDoc({
    surfaces: [{ id: "s1", label: "x", disposition: "reported", receiptRefs: ["../escape.json"] }],
  });
  const r = validateCoverage(badDoc);
  assert.equal(r.ok, false);
});

// —— validateCoverage 用例详版(spec 3 例) ——

test("C1 合法 coverage 通过", () => {
  const r = validateCoverage(minCoverageDoc());
  assert.deepEqual(r, { ok: true });
});

test("C2 缺 surfaces 报错", () => {
  const doc = minCoverageDoc();
  delete doc.surfaces;
  const r = validateCoverage(doc);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("surfaces")));
});

test("C3 deferred 类型错报错(应为数组)", () => {
  const r = validateCoverage(minCoverageDoc({ deferred: "none" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes("deferred")));
});

// —— 自审守卫(2026-10-20 findings #1/#5) ——
test('守卫 cand-01:循环 $ref schema 不崩溃,返回 ok:false(结构违规)', (t) => {
  const cyc = { type: 'object', properties: { a: { '$ref': '#/$defs/x' } }, '$defs': { x: { '$ref': '#/$defs/x' } } };
  const cycPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'cyc.json');
  fs.writeFileSync(cycPath, JSON.stringify(cyc), 'utf8');
  t.after(() => fs.rmSync(cycPath, { force: true }));
  const r = validateAgainstSchema({ a: 1 }, cycPath);
  assert.equal(r.ok, false, '循环 $ref 必须结构违规而非抛 RangeError');
});

// —— 重验守卫(2026-10-20 cand-08/09/10) ——
test('守卫 cand-08:深嵌套值不再抛 RangeError(echo 退化描述)', () => {
  const deep = (n) => { let v = 'x'; for (let i = 0; i < n; i++) v = [v]; return v; };
  const sch = { type: 'object', properties: { a: { enum: ['ok'] } }, required: ['a'] };
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'deep.json');
  fs.writeFileSync(p, JSON.stringify(sch), 'utf8');
  const r = validateAgainstSchema({ a: deep(50000) }, p);
  assert.equal(r.ok, false, 'enum 违规仍应报错');
});

test('守卫 cand-09:数组形式 type 生效(不匹配值被拦)', () => {
  const sch = { type: 'object', properties: { v: { type: ['string', 'object'] } }, required: ['v'] };
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'arrtype.json');
  fs.writeFileSync(p, JSON.stringify(sch), 'utf8');
  const r = validateAgainstSchema({ v: 12345 }, p);
  assert.equal(r.ok, false, 'number 穿过 [string,object] 必须被拦');
});

test('守卫 cand-10:startLine 违反 minimum 被拦', () => {
  const f = minFinding({ locations: [{ path: 'a.js', startLine: 0 }] });
  const r = validateFindings(minFindingsDoc([f]));
  assert.equal(r.ok, false, 'startLine 0 违反 minimum:1 必须被拦');
  if (!r.ok) assert.ok(r.errors.some((e) => e.path.includes('startLine')));
});
