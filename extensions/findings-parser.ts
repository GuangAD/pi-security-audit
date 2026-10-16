/**
 * extensions/findings-parser.ts — 扫描产物解析摘要
 *
 * 唯一解析 cs 扫描产物的模块;失败降级,不报假状态。
 * 契约:docs/plans/2026-10-16-pi-codex-security/spec.md「extensions/findings-parser.ts」节。
 *
 * 编码方向(spec 两条):
 *   1. 解析优先级:cs findings --json → 手解析 findings.json → report.md 降级。
 *      第一级经可注入 csFindingsProvider 呈现(默认 undefined 即跳过;真实 cs 调用由装配层注入)。
 *   2. 手解析仅做字段提取与计数,不做任何推理或去重(那是 cs 的事)。
 *
 * 产物路径:任务 2 固化的双层结构 <scanDir>/artifacts/{findings.json, report.md},
 * 只读该约定路径,不 import scan-runner。
 *
 * 降级裁决(controller):findings.json 不可解析时即使 report.md 存在也返回 degraded 对象,
 * 不返回伪 summary;source "report-md" 不在成功路径产出(成功恒为 "findings-json")。
 * 副作用:只读;降级/错误路径不回显任何产物文件内容。
 */
import fs from "node:fs";
import path from "node:path";

// —— 数据结构(spec「数据结构说明」节) ——

/** 严重级别四级(spec:counts 四键齐备,无该级发现为 0) */
export const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** top 发现单条(≤ 10 条,severity 降序,同级保持原序稳定) */
export interface TopFinding {
  severity: SeverityLevel;
  location: string;
  evidence: string;
  confidence?: string;
}

/** findings 摘要(spec 数据结构 FindingSummary) */
export interface FindingSummary {
  counts: Record<SeverityLevel, number>;
  topFindings: TopFinding[];
  source: "findings-json" | "report-md";
}

/** 三源全缺/缺损降级结果(spec 错误行为:不抛、不报假状态) */
export interface DegradedFindings {
  degraded: true;
  reportPath: string | null;
}

/** summarizeFindings 入参(解析优先级第一级的注入点;spec 签名的 opts 扩展,controller 批准) */
export interface SummarizeFindingsOptions {
  /** 解析优先级第一级:cs findings --json 的可注入 provider;默认 undefined 即跳过 */
  csFindingsProvider?: () => Promise<unknown>;
}

/** 数值预算:topFindings 条数上限(spec 数值预算表:≤ 10) */
export const TOP_FINDINGS_MAX = 10;

/** severity 降序秩(critical → high → medium → low);未知/缺失 level 无秩 → 宁缺勿错 */
const SEVERITY_RANK: Record<SeverityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** 值是否为四级 severity level(未知 level 如 "info" 不入计数与 top) */
function isSeverityLevel(value: unknown): value is SeverityLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value);
}

/** severity.level → 四级之一;字段缺失/未知返回 null(不臆造) */
function severityLevelOf(entry: Record<string, unknown>): SeverityLevel | null {
  const severity = entry.severity;
  if (severity === null || typeof severity !== "object") return null;
  const level = (severity as { level?: unknown }).level;
  return isSeverityLevel(level) ? level : null;
}

/** locations[0] → 稳定可读字符串(path 或 path:line);缺失/不可读按空 */
function locationText(entry: Record<string, unknown>): string {
  const locations = entry.locations;
  const first = Array.isArray(locations) ? locations[0] : undefined;
  if (typeof first === "string") return first;
  if (first !== null && typeof first === "object") {
    const loc = first as Record<string, unknown>;
    const file =
      typeof loc.path === "string" ? loc.path : typeof loc.file === "string" ? loc.file : null;
    if (file !== null) {
      return typeof loc.line === "number" ? `${file}:${loc.line}` : file;
    }
  }
  return "";
}

/** codeEvidence → 稳定可读字符串;缺失/不可读按空 */
function evidenceText(entry: Record<string, unknown>): string {
  const evidence = entry.codeEvidence;
  if (typeof evidence === "string") return evidence;
  if (evidence !== null && typeof evidence === "object") {
    const obj = evidence as Record<string, unknown>;
    if (typeof obj.snippet === "string") return obj.snippet;
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

/** confidence.level → 可选字段;缺失返回 undefined(键不出现,不臆造空串) */
function confidenceText(entry: Record<string, unknown>): string | undefined {
  const confidence = entry.confidence;
  if (confidence === null || typeof confidence !== "object") return undefined;
  const level = (confidence as { level?: unknown }).level;
  return typeof level === "string" ? level : undefined;
}

/**
 * findings 文档 → 摘要;文档形状无效(非对象)返回 null,表示「本级失败,继续降级」。
 * 手解析只做字段提取与计数:findings 键缺失按空、条目字段缺失按 0/空,
 * 未知/缺失 severity 不计数不入 top(宁缺勿错)。
 */
function summarizeFindingsDoc(doc: unknown): FindingSummary | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const rawFindings = (doc as { findings?: unknown }).findings;
  // findings 键整体缺失按空处理(字段缺失按 0/空);键存在但类型损坏视为文档无效 → 降级
  if (rawFindings !== undefined && !Array.isArray(rawFindings)) return null;
  const findings = Array.isArray(rawFindings) ? rawFindings : [];

  const counts: Record<SeverityLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const candidates: Array<{ finding: TopFinding; index: number }> = [];
  findings.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") return;
    const entry = raw as Record<string, unknown>;
    const severity = severityLevelOf(entry);
    if (severity === null) return; // 缺失/未知 level:不计数、不入 top
    counts[severity] += 1;
    const finding: TopFinding = {
      severity,
      location: locationText(entry),
      evidence: evidenceText(entry),
    };
    const confidence = confidenceText(entry);
    if (confidence !== undefined) finding.confidence = confidence;
    candidates.push({ finding, index });
  });

  // severity 降序(critical → high → medium → low),同级按原序稳定(下标次关键字),
  // 截断至数值预算上限(宁缺勿错:只截不补)
  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index,
  );
  const topFindings = candidates.slice(0, TOP_FINDINGS_MAX).map((candidate) => candidate.finding);

  return { counts, topFindings, source: "findings-json" };
}

/**
 * 对产物目录产出严重级别摘要(spec seam)。
 *
 * 解析优先级:
 *   1. cs findings --json —— opts.csFindingsProvider(可注入;默认 undefined 跳过)。
 *      provider 抛错或返回无效形状 → 本级失败,继续下一级(不抛)。
 *   2. 手解析 <scanDir>/artifacts/findings.json。
 *   3. report.md 降级 —— 只回传路径,不解析其内容(不臆造 summary)。
 * 三源全缺/全部失败返回 { degraded: true, reportPath } 不抛
 * (report.md 存在给绝对路径,否则 null)。只读,无写操作。
 */
export async function summarizeFindings(
  scanDir: string,
  opts?: SummarizeFindingsOptions,
): Promise<FindingSummary | DegradedFindings> {
  const findingsPath = path.resolve(scanDir, "artifacts", "findings.json");

  // 第一级:cs findings --json(provider 注入点,默认跳过)
  if (opts?.csFindingsProvider !== undefined) {
    try {
      const summary = summarizeFindingsDoc(await opts.csFindingsProvider());
      if (summary !== null) return summary;
    } catch {
      /* 第一级失败 → 手解析 findings.json(不回显错误内容) */
    }
  }

  // 第二级:手解析 findings.json
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
    const summary = summarizeFindingsDoc(parsed);
    if (summary !== null) return summary;
  } catch {
    /* findings.json 缺失/损坏 → 降级 report.md(不回显内容) */
  }

  // 第三级:report.md 降级 —— 存在给绝对路径,否则 null(三源全缺)
  const reportPath = path.resolve(scanDir, "artifacts", "report.md");
  return { degraded: true, reportPath: fs.existsSync(reportPath) ? reportPath : null };
}
