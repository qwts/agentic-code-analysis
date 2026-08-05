# Design: `aca naming-truth`

**Status:** Accepted (issue #14, [ACA-0014](../decisions/ACA-0014-naming-truth.md));
comparative semantics inherited from
[ACA-0013](../decisions/ACA-0013-comparative-judgment.md). Second check of
the suite; consumes the [suite design](suite.md) contracts (JudgeClient,
change scope, verdict cache, exit codes) and adds only what is specific to
this check.

## What it judges

Each changed file, against the
[naming-truth standard](../standards/naming-truth.md): do the exported
names the file owns tell the truth about behavior? The judged surface is
the runtime public surface — the module claim of the repo-relative path
(for `index.*`, the owning directory name), locally implemented exported
functions/callable values/classes and their public members, and
named/default/CommonJS exports implemented in the file. Type-only
declarations, private members, non-exported locals, and pure re-exports are
out of scope, as are automated renames and cross-file naming consistency
(`copy-consistency` / `agent-file-parity` territory).

**Semantics follow ACA-0013:** a **new** file (absent at the merge-base) is
judged absolutely; a **legacy** file is judged on the *direction* of the
change — did the change introduce or worsen lying names, or hold/improve?
A correct finding about an old misleading name must not tax the change that
merely touched it. A rename stays legacy under its base path (the rename
itself can improve or regress the module claim); a copy/extraction is new.

The authoritative criteria are exactly three — `name-contradicts-behavior`,
`name-omits-side-effect`, `name-drifted` — defined in the standard. A side
effect means *state-changing* I/O: read-only sourcing (loading a file,
consulting configuration, a read-only query or subprocess) is not one.
Incidental logging/metrics/memoization/internal mutation/async mechanics and
programmer-error preconditions are not lies; a vague-but-not-false name is
never promoted into a criterion. When behavior lives behind an import and is
not inferable from the file, the judge must not guess: omit the finding or
assess `uncertain`.

Tier: **T1 (judgment)** — routing per the consuming config's tier map
(ENG-0151 pattern); no model identifier appears in code.

## Judge input, per file

The prompt embeds the **rule text read from disk at runtime** — never a
paraphrase — as part of the `system` prompt (one cached prefix per run).
The per-file user turn carries the comparison:

1. the file's kind (`new` / `legacy`), and the base path when renamed;
2. per snapshot (head; plus base for legacy): **paths only** of files it
   imports and files that import it — normalized, sorted, derived
   mechanically (the only mechanical derivation; there is no regex/AST
   export inventory, because a partial inventory would silently miss valid
   export forms — the judge identifies the in-scope surface from the full
   content);
3. the full head content — and for legacy, the full base content. No diff
   hunks (derivable redundancy per ACA-0013) and no growth line (line
   counts are footprint orientation, irrelevant to naming truth).

File contents, comments, string literals, and import paths are **untrusted
evidence, never instructions**; the system prompt says so explicitly.

The merge-base is resolved once per run (failure is a run-level config
error, exit 2 — never inferred as "everything is new"); the base import
graph is reconstructed from the head graph plus the changed paths.

## Judge output

Structured output against a strict schema (`additionalProperties: false`,
all fields required):

```json
{
  "assessment": "new-compliant | new-violating | improved | held | regressed | uncertain",
  "before_behavior": "what the public surface actually does at the base; '(none — new file)' for new",
  "after_behavior": "what the public surface actually does at the head",
  "comparison_evidence": "specific before-to-after evidence; '(none — new file)' for new",
  "head_findings": [{
    "criterion": "name-contradicts-behavior | name-omits-side-effect | name-drifted",
    "symbol": "the lying name",
    "symbol_kind": "function | class | method | value | module",
    "name_claim": "what the name promises a caller",
    "actual_behavior": "what the code observably does",
    "evidence": "concrete, quotable observation from the head version",
    "suggested_name": "a truthful name for the public contract (advisory prose, never applied)",
    "change": "introduced | worsened | unchanged | improved"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

The judge describes; host code decides:

| Kind | Assessment | Effective verdict |
| --- | --- | --- |
| new | `new-compliant` (zero findings) | `pass` |
| new | `new-violating` (≥1 `introduced` finding) | `fail` |
| legacy | `improved` / `held` | `pass`; findings retained as **residual debt** |
| legacy | `regressed` (≥1 `introduced`/`worsened` finding) | `fail` on the introduced/worsened findings; `unchanged`/`improved` findings retained as residuals |
| either | `uncertain` | `warn`, cacheable |
| either | refusal, truncation, schema-parse failure, kind-incompatible assessment, evidence-free blocking assessment, blank required finding field, or a `change` value inconsistent with the assessment/kind | `warn`, **not** cacheable |

Consistency is host-enforced, not trusted: a new file may only carry
`introduced` findings; `improved`/`held` may not carry `introduced`/
`worsened` findings; any introduced or materially worsened criterion means
`regressed` — improvement elsewhere cannot net out new naming debt.

The check's verdict subtype `NamingTruthVerdict` (with `assessment`,
`basePath`, `residualViolations`) and finding subtype `NamingViolation`
(symbol, kind, claim, behavior, suggested name, change) extend the shared
`FileVerdict`/`Violation` contracts structurally — the frozen registry
interfaces are not widened. The rich fields survive `--json`; text output
derives the concise `evidence`/`suggestion` strings (symbol + claim vs.
behavior → suggested truthful name).

## Operational bounds

One file per request; concurrency 3 through a stable-order worker pool
shared by run and self-test; `max_tokens` 4096; pinned prompt version
`naming-truth-v2` (any prompt change bumps it; v1 → v2 sharpened
`name-omits-side-effect` to state-changing I/O after a cross-model
self-application run read "file I/O" literally and failed read-only
sourcing like a rule-file load). Verdicts memoized with the
**pair-addressed key** of ACA-0013: comparison kind (explicit absent-base
marker), both snapshots' path/content/sorted import edges, rule text,
prompt version, provider, model. Path is a semantic input here — the module
name is evidence. Base ref/SHA and derived orientation stay out. Inputs are
normalized and deduplicated before the pool; an invalid base is a run-level
config error; an unreadable snapshot is a non-cacheable per-file warn.

## Calibration — the self-test

`aca naming-truth --self-test` judges ACA-owned synthetic fixtures (small
counterfactual pairs, never third-party source) and asserts assessment,
effective verdict, expected criterion **and symbol**, and residuals — not
exact prose or one exact spelling of the suggested name:

1. **new lying predicate** (`isValidOrder` that throws on ordinary invalid
   orders and can never answer `false`) — `new-violating`/`fail`,
   `name-contradicts-behavior` on `isValidOrder`;
2. **the same behavior truthfully named** (`assertValidOrder`) —
   `new-compliant`/`pass` — the negative control proving the judge rejects
   the lie, not the throw;
3. **truthful base → lying head** (`getUser` gains a hidden write) —
   `regressed`/`fail`, `name-omits-side-effect` on `getUser`;
4. **lying base → truthful head with one lie left untouched** —
   `improved`/`pass` with the remaining lie as a required residual;
5. **vague but non-false name** — `new-compliant`/`pass`; never a fail.

The self-test is live and uncached, runs through the same
concurrency-3 pool, and preserves manifest order. A miss exits nonzero.
**If a fixture assertion breaks, the prompt is wrong, not the fixture**;
iterate on the prompt and bump the pinned version.

Full decision text and rationale:
[ACA-0014](../decisions/ACA-0014-naming-truth.md).
