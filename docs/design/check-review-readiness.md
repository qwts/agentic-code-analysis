# Design: `aca review-readiness`

**Status:** Accepted (2026-08-05). First diff-scoped check; consumes the
[suite design](suite.md) contracts (JudgeClient, change scope, verdict
cache, exit codes) and the diff-fixture corpus / canonical diff artifact /
diff judge I/O convention of
[ACA-0020](../decisions/ACA-0020-diff-fixture-corpus.md). Adds only what is
specific to this check.

## What it judges

**One judgment over the whole diff: is this change ready for human
review?** The scope is the CLI-selected change set (merge-base of the base
ref vs the working tree, filtered by the consuming repo's globs; explicit
paths bypass selection), assembled into one canonical diff artifact — the
whole-diff view is the point: three unrelated debug prints are one signal
of an unswept change, not three independent lint hits. This is
*whole-artifact single-call judgment*, deliberately contrasted with
`context-footprint`'s per-file fan-out: that check judges each file's
standing property, this one judges a property of the change itself.

Every criterion here is individually lintable; the judgment "intentional
or forgotten?" is not. A commented-out block can be a deliberate
breadcrumb, a `console.log` can be the feature. Judged-intentional items
are **not** findings — that judgment is the check.

Criteria (the only valid finding labels):

- `leftover-debug` — debug prints/dumps that served the author, not the
  code (`console.log('HERE', …)`, commented-fast dbg helpers).
- `commented-out-code` — code disabled in place with no explanation, where
  deletion (the history keeps it) is the reviewable act.
- `unlinked-todo` — TODO/FIXME/HACK introduced with no issue link or
  actionable context.
- `silenced-test` — a test newly skipped, disabled, or gutted without a
  stated reason.
- `unexplained-magic-value` — a load-bearing literal introduced without a
  name or derivation where intent is not local.

Findings anchor to **added head lines only** (`file` + `line` from the
hunks); removed and context lines may inform intent but are never
reportable. Advisory sweet spot: run pre-PR in the dev loop — suggestions
are phrased as pre-review fixes ("delete the print", "link the issue"),
never review verdicts.

Out of scope: whether the diff is one coherent change (sibling
`commit-coherence`, #22); style/formatting (linters own it); secret
detection (scanner territory plus backlog `secret-hygiene`); generic code
review.

Tier: **T1 (judgment)**. Routing per the consuming config's tier map
(currently T1 → Anthropic `claude-opus-5`, provisional; no model name in
source).

## Judge input

One request per run. The `system` turn carries the criteria definitions and
the intentional-vs-forgotten instruction; the `user` turn is the ACA-0020
payload: the artifact rendered unified-style, context/added lines prefixed
with their head line numbers, bounded at `MAX_PAYLOAD_CHARS` (120k chars).
Oversized runs omit whole files deterministically; omitted files are named
to the host (never to a silent truncation) and projected as `warn` — a
bounded run can fail on what it saw but can never fully pass.

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "ready | not-ready | uncertain",
  "findings": [{
    "criterion": "leftover-debug | commented-out-code | unlinked-todo | silenced-test | unexplained-magic-value",
    "file": "repo-relative path from the payload",
    "line": 42,
    "evidence": "the anchored line, quoted, with why it reads forgotten rather than intentional",
    "suggestion": "the pre-review fix"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

The judge describes; host code decides:

| Assessment | Findings | Effective outcome |
| --- | --- | --- |
| `ready` | none | `pass` |
| `not-ready` | ≥1, all anchors valid | `fail` on those findings |
| `uncertain` | none | `warn`, cacheable |
| `ready`/`uncertain` | any | contradiction → `warn`, **not** cacheable |
| `not-ready` | none, or any unknown criterion, invalid/stale anchor, blank evidence | degradation → `warn`, **not** cacheable |
| refusal / schema mismatch / transport error | — | `warn`, **not** cacheable |

Anchor validity is host-checked against the artifact's added-line index; a
judge citing a context line, a removed line, or an out-of-scope file is a
malformed reply (degradation), never a dropped finding or a silent pass.

## Projection to the frozen contracts

The judgment is artifact-level; the renderer receives the standard
`FileVerdict[]` by projection, after judgment:

- findings group by file → `fail` entries; `violations[].evidence` is
  prefixed `path:line` so text output stays anchored; a check-local verdict
  subtype (`ReviewReadinessVerdict`) retains the structured `findings`
  (with numeric `line`) and a shared `run` object — judge call count,
  cache decision, judged/omitted coverage — which `--json` exposes without
  widening `FileVerdict`, `JudgeClient`, `VerdictCache`, or the check
  contract (every entry carries the same `run` object; duck-typed like
  `residualViolations`);
- clean judged files → silent `pass` entries; scoped files with no hunks →
  `pass` with a note;
- omitted files → `warn` naming the unjudged hunk ranges;
- artifact-level `warn` (uncertain or degraded) → every judged file warns
  with the shared note.

## Cache and bounds

One cache lookup, then **exactly one judge call per run** on a non-empty
miss — outside any file loop; an empty scope or hunkless diff makes zero
calls. `max_tokens` 4096. The key holds every semantic input: prompt
version, the **full canonical artifact** (including content omitted from a
bounded payload), the bounded payload and omission manifest actually sent,
provider, model — never branch name, SHA, or base-ref identity. Re-running
an unchanged unpushed worktree makes zero API calls; a change confined to
omitted content still invalidates. Only well-formed `pass`/`fail`/judged-
`uncertain` outcomes cache; degradations retry next run.

## Calibration — pair fixtures (ACA-0020, graded per ACA-0012)

`aca review-readiness --self-test` runs live (never cached), one call per
case, over pair fixtures in `checks/review-readiness/fixtures/`:

- **`discriminates`** (required level): a multi-file change introducing a
  debug print and a newly-skipped test must judge `not-ready`/`fail`
  naming **both** `leftover-debug` and `silenced-test` at valid anchors —
  either missing is a miss; a comparable clean change (intentional
  logging, named constants, updated tests) must judge `ready`/`pass` with
  zero findings.

The manifest is validated before any call; prompt misses are fixed in the
prompt, never by weakening fixtures; every prompt change bumps the pinned
version (invalidating the verdict cache by construction).

## Evidence

Self-test discriminates the pair; `--json` proves one judge call per run
regardless of file count and exposes coverage/omissions and the cache
decision; the cache test proves zero calls on an unchanged diff.
