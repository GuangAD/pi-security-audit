# Final Report（报告契约）

> 来源:改写自 codex-security `references/final-report.md`(Apache License 2.0,Copyright OpenAI)。cs 的 workbench/record_* 检查点在本架构中替换为产物目录文件;deep/usage 段落裁剪。

The final readable output is a deterministic projection of `findings.json` and `coverage.json` (plus `scan-context.json` for scope):

- primary readable markdown report at `<scan_dir>/report.md`
- optional detailed vulnerability write-ups under `findings/<slug>/`, linked from the primary report through `finding.writeup.reportPath`

When writing `findings.json` alongside this readable output, populate the optional structured details in `finding-detail-fields.md` from the same validated evidence. Do not parse the rendered report back into finding data.

Use `report.md` as the primary readable entry point. Explain report-relevant artifact paths in the report itself, especially in `Scope`, `Reviewed Surfaces`, and `Open Questions And Follow Up`.

For each finding, supply an evidence-supported lowercase vulnerability-family `ruleId`; `taxonomy: { category, cwe }` using its exact known CWEs; verified locations; and `provenance.source`. A finding with no known CWE retains `cwe: []`; never invent a classification. Include optional `codeEvidence` only when its actual code is nonempty and every referenced evidence ID is present.

Supply semantic coverage as `{ surfaces, explicitExclusions, deferred }`, with each surface using the actual `label` and one existing `disposition`. Retain deferred items and `needs_follow_up` surfaces with their reasons and evidence. Exclusions and unresolved questions do not prevent the review from finishing. Each deferred item needs a meaningful reason. Open questions may be nonempty strings or `{ question, followUpPrompt? }` objects.

Before declaring the audit complete, run the artifact validator (`validate_scan_artifacts`) on both `findings.json` and `coverage.json`; a validation rejection makes no report. Correct only the named paths, preserving all valid findings, fields, evidence, and deferred work. Do not blindly retry an ambiguous write failure, and never author `report.md` as a substitute for valid canonical JSON.

On a confirmed failure or explicit cancellation, preserve saved results without marking the scan successful. Report validated findings separately from pending candidates and describe scope limitations and remaining work.

Canonical report semantics live in these fields:

- `scan-context.json`: `scope` and `threatModel`
- `findings.json`: each finding's `summary`, `codeEvidence`, `rootCause`, `validation`, `attackPath.dataflow`, `attackPath.reachability`, `severity.rationale`, `severity.changeConditions`, `remediation`, `remediationTests`, and `preventiveControls`
- `findings.json`: optional `writeup.reportPath` for a derived detailed vulnerability report written under `findings/<slug>/<slug>.md`
- `coverage.json`: `surfaces` including `riskArea` and `notes`, plus `openQuestions`

When there are no reportable findings, include a short `No findings` section that explains why nothing survived discovery or the later reportability gates. For repository-wide and scoped-path scans, still include `Reviewed Surfaces` so checked, rejected, not-applicable, and follow-up-needed surfaces remain auditable.

When there are reportable findings, render them as readable markdown findings rather than raw JSON or a dumped schema object.

Order findings from highest severity to lowest severity: `critical`, then `high`, then `medium`, then `low`.

Group observations only when they share the same broken security control and effective remediation. Preserve every affected route, operation, sink, and supporting source location; keep distinct security failures separate even when they share a CWE.

Set the finding category and CWE from the primary broken control. Do not add secondary support-impact CWEs, such as data exposure or missing authentication, to an injection/RCE/path/file/parser finding merely because they make exploitation worse; mention those impacts in prose or emit a separate finding if that secondary control is independently vulnerable.

Canonical `severity.changeConditions` must be one non-empty string; when multiple change-condition strings exist, join them into one prose string before writing `findings.json`.

Diff-scan candidates apply row outcomes in this order: validation disposition `reportable` plus attack-path decision `reportable` becomes a finding with its distinct instance and all relevant entrypoint, root-control, sink, and supporting locations; otherwise, a `deferred` result from either phase becomes `needs_follow_up` coverage and a `coverage.deferred` entry using the recorded uncertainty or proof gap; otherwise, validation disposition `not_applicable` becomes `not_applicable` coverage; otherwise, validation disposition `suppressed` or attack-path decision `ignore` becomes `rejected` coverage. A missing required phase record leaves the candidate unresolved; retain it with its available evidence and the missing step.

## Report Structure

`# Security Review: <repo_or_target_name>`

`## Scope`

Populate `scan.scope` with in-scope context, artifacts reviewed, runtime or test status, validation mode, and explicit limitations. Include/exclude paths and coverage fields supply the remaining projected scope content. If the threat model was generated during the audit rather than provided by the user, say that in canonical scope context. Do not call generated threat-model material an external input.

After the scope bullets, include a compact `### Scan Summary` table when the scan has findings or repository-wide coverage. Use columns `Field` and `Value`. Include the count of reportable findings, severity mix, confidence mix, validation mode, and concrete limitations when those values are known. Keep artifact paths below this table.

`## Threat Model`

Use the completed canonical `threatModel` when one exists. Use the field mapping and scenario reconciliation in `threat-model.md` when building a generated structured model; do not regenerate it from the final finding list. Preserve source citations, capability boundaries, deployment assumptions, and material unknowns.

`## Findings`

Start this section with the findings summary table. For non-deep modes, use columns `Finding`, `Severity`, `Confidence`, and `Detailed write-up`, with the finding title linking to the detailed summary section.

After the summary table, include a compact `### Confidence Scale` table with columns `Label` and `Meaning`:

- `high`: direct source, configuration, or runtime evidence supports the finding, with no material unresolved reachability or exploitability blocker.
- `medium`: source evidence supports a plausible issue, but runtime behavior, deployment configuration, role reachability, type constraints, or exploit reliability still need proof.
- `low`: weak or incomplete evidence; include only when the user explicitly wants follow-up candidates in the final report.

When a finding records `writeup.reportPath`, link the detailed report from the findings summary and do not duplicate the complete finding inline. Findings without a write-up use the inline format below.

Render each inline finding as:

`### [<number>] <title>`

For each finding include a compact two-column metadata table immediately below the heading. Use columns `Field` and `Value`. Include these rows:

- `Severity`: `critical|high|medium|low`
- `Confidence`: `high|medium|low` or a short calibrated confidence label
- `Confidence rationale`: one sentence explaining why the confidence label is calibrated that way, grounded in the validation method, direct evidence, and missing proof if any
- `Category`: concrete vulnerability class
- `CWE`: id and name list, or `none`
- `Affected lines`: path:line-range list

Use a concrete category such as `Authorization bypass / IDOR`, `Path traversal`, `SQL injection`, `XXE`, `Open redirect`, or `Hardcoded credentials`. Do not use generic placeholders such as `security scan finding`.

The summary table and the detailed finding sections must use the same descending severity order: all `critical` findings first, then `high`, then `medium`, then `low`. Renumber findings after sorting so the table order, detailed headings, and anchors match.

`## Reviewed Surfaces`

List every reviewed surface with its disposition (`reported`, `no_issue_found`, `rejected`, `not_applicable`, `needs_follow_up`), risk area, and notes. This section keeps checked, rejected, and not-applicable surfaces auditable.

`## Open Questions And Follow Up`

List unresolved questions (each optionally with a `followUpPrompt`) and every `deferred` item with its reason. These do not fail the audit; they bound its claims.
