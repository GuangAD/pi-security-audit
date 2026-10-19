# Artifact Contract（产物契约）

> 来源:改写自 codex-security `references/artifact-storage.md` 与 `references/scan-artifacts.md`(Apache License 2.0,Copyright OpenAI)。cs 的 MCP 存储工具(save/read_codex_security_artifact)在本架构中替换为「直接写产物目录」;deep/workbench 段落裁剪。

## Directory Layout

One audit owns one directory: `<repository>/.security-audit/<YYYYMMDD-HHmmss>/`. The orchestrator creates it before dispatching workers and records its absolute path in every worker brief. Never invent or guess scan IDs; the directory name is the human-visible scan identity, while `scanId` inside JSON documents is the machine identity (stable, lowercase, derived from the target and timestamp).

```text
.security-audit/<ts>/
├── scan-context.json    # mode/scope/base/model/timestamp/knowledgeBase — single source of truth
├── findings.json        # conforms to schemas/findings.schema.json
├── coverage.json        # conforms to schemas/coverage.schema.json
├── report.md            # human-readable report (final-report.md contract)
├── threatmodel.md       # derived from the canonical threatModel checkpoint
└── checkpoints/         # stage checkpoints, written before and after each decision
    ├── threat-model.json
    ├── scan-draft.json
    ├── baseline.json
    ├── investigators/<packet-id>.json
    ├── validations/<candidateId>.json
    └── false-positive-feedback.json   # optional reviewer feedback input
```

## Writing Rules

1. Workers write their own outputs under `checkpoints/` (one file per stage/packet/candidate). The orchestrator owns everything at the directory root: `findings.json`, `coverage.json`, `report.md`, `threatmodel.md`, `scan-context.json`.
2. Structured data is JSON written with the file tool; `report.md` is Markdown. Never author canonical JSON files through ad-hoc shell redirection when the file tool is available; shell is for reading source and running searches.
3. Checkpoint early and often: write `complete: false` snapshots before waiting on workers, after each validation decision, and before any long-running step. An unfinished audit must always leave a readable trail — saved findings, pending candidates with `candidateId`, and unresolved questions — without presenting pending work as validated.
4. Keep the target source read-only. PoC/build outputs that are not part of the audit record go to an OS temporary directory, never into `.security-audit/`; import into the record only the actual bytes of files you need (copy the file, do not transcribe logs).
5. Temporary staging must not be referenced from canonical findings or coverage. Retained evidence lives under `checkpoints/` or is inlined as `codeEvidence`.
6. Deleting or rewriting the audit directory of a *completed* audit is not part of any workflow; a rerun creates a new timestamped directory.

## Evidence References

Reference evidence by repository-relative path + line range in `codeEvidence` entries (`id`, `label`, `path`, `startLine`, `code`, `explanation`). Use `code`, never `snippet`. Evidence paths in coverage `surfaces[].receiptRefs` point at `checkpoints/` files that substantiate the surface disposition.

## Threat-Model Cache

For a standalone repository threat model, end the shared document with two lines: `Repository: <stable target identity>` and `Version: <revision or snapshot digest>`. Reuse a cached `threatmodel.md` only when the workflow allows cache reuse and the footer matches the current target exactly; otherwise generate fresh. Saving a scan's model does not authorize updating a shared cache.
