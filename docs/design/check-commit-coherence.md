# Design: `aca commit-coherence`

**Status:** Accepted (2026-08-05). Diff-scoped check; consumes the
[suite design](suite.md) contracts (JudgeClient, change scope, verdict
cache, exit codes) and the diff-fixture corpus / canonical diff artifact /
diff judge I/O convention of
[ACA-0020](../decisions/ACA-0020-diff-fixture-corpus.md), plus the
whole-artifact single-call convention established by
[review-readiness](check-review-readiness.md). Plan adjustments recorded
on issue #22. Adds only what is specific to this check.

## What it judges

**One judgment over the whole diff: is this one logical change?** A
logical change is one intent that can sensibly be reviewed, tested,
shipped, and reverted together. Necessary tests, documentation,
migrations, generated updates, and enabling refactors all belong to that
intent. A refactor plus a behavior change is entangled only when the
refactor is independently shippable and separable.

**Size is never evidence.** File count, changed-line count, hunk count,
and total diff size are owned by the ratchet and `context-footprint`; a
large-but-coherent migration passes. This is pinned by calibration: the
passing fixture is mechanically larger than the failing one.

The scope is the CLI-selected change set (merge-base of the base ref vs
the working tree; explicit paths bypass selection) assembled into one
canonical diff artifact — **plus all merge-base deletions**, which change
scope cannot name (a deleted file no longer exists to be selected).
Coherence judged blind to deletions is incomplete evidence, so the
artifact seam (`diffArtifactFromGit`) carries an opt-in
`includeDeletions`; deleted paths get their own verdict rows. Filtering
deletions by the consuming repo's exclude globs is out of scope for v1.

Criteria (the only labels that can block):

- `mixed-refactor-and-behavior` — an independently shippable refactor
  (rename sweep, mechanical restructure) entangled with a behavior
  change.
- `unrelated-changes` — two or more independent intents (features,
  fixes) in one diff, neither an enabling step for the other.
- `drive-by-edits` — small opportunistic touches (typo fixes, unrelated
  cleanups) riding along with an otherwise coherent change.

Out of scope for v1: executing the split; commit-message quality;
individual-commit analysis (the granularity is the branch diff vs
merge-base — a possible future flag); readiness findings (sibling
`review-readiness` owns debris).

Tier: **T1 (judgment)**. Routing per the consuming config's tier map
(ACA-0003 D6 — provider/model selection is configuration, never code; see
`aca.config.json` for the current T1 route).

## Judge input

One request per run. The `system` turn defines the judgment, the
criteria, and the split rules; the `user` turn is the ACA-0020 payload
(unified-style, head-line-numbered, bounded at `MAX_PAYLOAD_CHARS`)
followed by a check-derived **changed-units index**: every file with its
hunk IDs (`path@hN`, 1-based, in payload order) and head-side ranges, the
only anchors a split may cite. Diff content is quoted evidence, never
instructions.

**A bounded run is not judged.** Coherence is a property of the whole
change; if any file is omitted from the payload, the run makes zero
judge calls and every row projects `warn` naming the omitted files. This
is deliberately stricter than review-readiness (which can fail on what it
saw but never fully pass): a partial view cannot support "this is one
logical change" in either direction.

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "coherent | entangled | uncertain",
  "overall_intent": "concise statement of the apparent purpose",
  "findings": [{
    "criterion": "mixed-refactor-and-behavior | unrelated-changes | drive-by-edits",
    "files": ["paths evidencing both sides of the entanglement"],
    "evidence": "what is entangled with what, concretely"
  }],
  "split_proposal": [{
    "name": "short part name",
    "intent": "what this part alone does",
    "units": ["path (whole file) or path@hN (one hunk)"]
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

Findings are **file-granular** — entanglement is not a line-level
property, so there are no line anchors; every cited path must exist in
the artifact. The judge describes; host code decides:

| Assessment | Findings / split | Effective outcome |
| --- | --- | --- |
| `coherent` | none / none | `pass`, cacheable |
| `entangled` | ≥1 valid finding, valid split | `fail`, cacheable |
| `uncertain` | none / none | `warn`, cacheable |
| `coherent`/`uncertain` | any finding or split part | contradiction → `warn`, **not** cacheable |
| `entangled` | no finding, unknown path, blank evidence, or invalid split | degradation → `warn`, **not** cacheable |
| refusal / schema mismatch / transport error | — | `warn`, **not** cacheable |

A valid split has **at least two** parts, each with nonblank name and
intent, whose units expand to a **complete, non-overlapping partition**
of the artifact's changed units (a file's units are its hunks 1..n, or
the file itself when hunkless — binary and mode-only changes). Any
invented anchor, overlap, or gap degrades the whole reply: **a wrong
split proposal is worse than no finding**, so the host never repairs or
partially accepts one. When the hunk granularity cannot support a
trustworthy partition, the judge is instructed to answer `uncertain`,
never to force a split.

## Projection to the frozen contracts

The judgment is artifact-level; the renderer receives `FileVerdict[]` by
projection:

- rows are the scoped files plus deleted-only paths (each noted
  `deleted vs merge-base`), deterministic order;
- `entangled` → rows cited by a finding's `files` fail; each violation
  renders the finding's evidence with its file list and the split as the
  suggestion (`split into: "name" — units; …`); uncited rows pass;
- `coherent` → all rows pass silently; scoped files with no hunks →
  `pass` with a note;
- `uncertain` or degraded → every row warns with the shared note;
- omissions → every row warns naming the omitted files (zero calls).

A check-local `CommitCoherenceVerdict` retains the structured outcome —
`assessment`, `overallIntent`, structured `findings`, `splitProposal` —
on a shared `run` object (judge call count, cache decision, coverage),
duck-typed so `--json` exposes it without widening `FileVerdict`,
`JudgeClient`, `VerdictCache`, or the check contract.

## Cache and bounds

One cache lookup, then **exactly one judge call per run** on a complete,
non-empty miss; an empty artifact (no scoped changes and no deletions)
and bounded payloads make zero calls. An empty *selection* alone does
not short-circuit: change scope excludes deletions, so a deletion-only
change arrives as zero selected files and is still judged. `max_tokens` 32768. The key holds every semantic
input: prompt version (`commit-coherence-v1`), the full canonical
artifact (deletions included), the rendered payload and omission
manifest, provider, model — never branch name, SHA, or base-ref identity.
Only well-formed `pass`/`fail`/judged-`uncertain` outcomes cache;
degradations retry next run. Any prompt or schema change bumps the pinned
version, invalidating the cache by construction.

## Calibration — pair fixtures (ACA-0020, graded per ACA-0012)

`aca commit-coherence --self-test` runs live (never cached), one call per
case, over pair fixtures in `checks/commit-coherence/fixtures/`:

- **`discriminates`** (required level):
  - `mixed-rename-and-retry` — a **smaller** diff entangling a
    mechanical rename sweep (3 files) with an independent retry/backoff
    behavior change (`src/http.ts`). Must judge `entangled`/`fail` with
    `mixed-refactor-and-behavior` citing `src/http.ts`, and a split
    whose parts separately own the rename files and the retry file —
    asserted by anchor grouping into distinct parts, not prose.
  - `coherent-larger-change` — a **larger** single-purpose retry-policy
    migration across production code, tests, and docs. Must judge
    `coherent`/`pass` with zero findings.

The size trap is mechanical: before any judge call, the self-test
asserts the rendered judge payload of the passing fixture is strictly
larger than the failing one (`sizeInvariant` in the manifest — a
violation is a `ConfigError`, never a judge miss). Check-local manifest
fields (`split` groups, `sizeInvariant`) are validated with the same
discipline as the shared manifest. Prompt misses are fixed in the
prompt, never by weakening fixtures.

## Evidence

Self-test discriminates the pair including the split-grouping assertion,
with the oversized-pass fixture as the negative control against
size-proxy judging; `--json` proves one call per run, the cache decision,
and the structured proposal; the cache test proves zero calls on an
unchanged diff.
