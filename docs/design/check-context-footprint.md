# Design: `aca context-footprint`

**Status:** Accepted; comparative semantics per
[ACA-0013](../decisions/ACA-0013-comparative-judgment.md) (2026-08-05).
First check of the suite; consumes the [suite design](suite.md) contracts
(JudgeClient, change scope, verdict cache, exit codes) and adds only what is
specific to this check.

## What it judges

Each changed file, against the vendored
[file-context-footprint standard](../standards/file-context-footprint.md).
The judge answers the standard's own practical test: *what is the smallest set
of files a model must load to work on this concept safely and correctly?*
Both failure directions count — oversized mixed-responsibility files and
excessively fragmented abstractions. The check exists because length ratchets
punish the symptom, and a model under a ratchet relocates a blob rather than
fixes the concept; telling relocation from design requires judgment.

**Semantics depend on the file's kind** (ACA-0013, superseding ACA-0004 D5's
absolute state for legacy files):

- a **new** file (absent at the merge-base) is judged absolutely — greenfield
  stays honest;
- a **legacy** file (present at the merge-base) is judged on the *direction*
  of the change: did its context footprint improve, hold, or regress? Debt
  that predates the change never blocks; making it worse does. A rename stays
  legacy under its base path; a copy/extraction is new.

Tier: **T1 (judgment)** — the whole point is discrimination a mechanical
check cannot make. Routing per the consuming config's tier map (ENG-0151
pattern; registry currently seeds T1 → Anthropic `claude-opus-5`, provisional).

## Judge input, per file

The prompt embeds the **vendored rule text read from disk at runtime** — never
a paraphrase in the script, so the rule and the judge cannot drift apart.
Rule text plus judging instructions form the `system` prompt (one cached
prefix shared across every file in a run); the per-file payload is the user
turn, built from the file's comparison:

1. the file's kind (`new` / `legacy`), and the base path when renamed;
2. one growth line (new / grew / shrank / unchanged, with line counts) —
   orientation, never the decision;
3. per snapshot (head; plus base for legacy): **paths only** (not contents)
   of files it imports and of files that import it;
4. the full head content — and for legacy, the full base content.

The merge-base is resolved once per run (failure is a run-level config
error, exit 2 — never inferred as "everything is new"); the base import
graph is reconstructed from the head graph plus the changed paths, so
modified, deleted, and renamed importers are represented without one git
process per repository file. Diff hunks were dropped in v2: with both
snapshots in the payload they are derivable redundancy.

**Load-set accounting (review clarification, 2026-08-04).** The practical
test counts an import toward the load-set whenever the imported file must be
*opened* to understand this one — not when its name at the boundary is
enough. A well-bounded file is comprehensible from its own content plus the
names it imports; needing to pull an import's contents into context is the
edge case, not the norm. A short file so fragmented that nearly every line
leans on an imported symbol therefore has a large effective footprint despite
its line count — `over-fragmentation` or `incomplete-concept` territory.
Conversely, a leaf file swept into the change set is still judged as it
stands: its verdict describes its own footprint, never a neighbor's problem
inherited through the diff.

## Judge output

Structured output against a strict schema (`additionalProperties: false`, all
fields required):

```json
{
  "assessment": "new-compliant | new-violating | improved | held | regressed | uncertain",
  "before_practical_test": "the practical-test answer for the base version; '(none — new file)' for new",
  "after_practical_test": "the practical-test answer for the head version",
  "comparison_evidence": "specific before-to-after evidence for the assessment",
  "head_violations": [{
    "criterion": "mixed-responsibility | incomplete-concept | relocation-not-design | over-fragmentation | duplicated-context",
    "evidence": "specific, quotable observation from the head version",
    "suggestion": "the concrete restructuring that would fix it"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

The judge describes; host code decides. One comparative call per file — no
cost doubling, and comparative questions are more reliable than two absolute
scores subtracted.

**Effective-verdict mapping — the load-bearing part:**

| Kind | Assessment | Effective verdict |
| --- | --- | --- |
| new | `new-compliant` | `pass` |
| new | `new-violating` (evidence required) | `fail` |
| legacy | `improved` / `held` | `pass`; head violations retained as **residual debt** |
| legacy | `regressed` (evidence required) | `fail` |
| either | `uncertain` | `warn`, cacheable |
| either | malformed, kind-incompatible, or evidence-free blocking assessment | `warn`, **not** cacheable |

- `improved` requires a material footprint reduction and no introduced or
  materially worsened criterion; any new or worsened criterion is
  `regressed` even when another area improved — new debt cannot be netted
  against cleanup elsewhere.
- Residual debt is structured and nonblocking: `violations` stays blocking
  evidence on fails; `residualViolations` (the check's verdict subtype —
  the shared `FileVerdict` contract is not widened) carries what an
  improved/held legacy file still owes. Text output prints a residual pass
  as a finding (`pass (footprint improved; residual debt)` plus criteria);
  only clean passes stay silent; the summary counts residual files
  separately; `--json` exposes `assessment`, `basePath`, and both violation
  lists. `--enforce` blocks only effective `fail`.
- **Ambiguity is `uncertain` → `warn`, never `fail`.** A judge that fails on
  vibes gets the gate disabled within a week; a gate that warns honestly
  earns promotion to `--enforce`.
- Refusal, truncation, or schema-parse failure → non-cacheable `warn` with a
  note. Never a crash, never a silent pass.

## Operational bounds

One file per request; concurrency 3; `max_tokens` 32768; no sampling
parameters. Inputs are normalized and deduplicated before the worker pool.
Verdicts memoized per the suite cache design with a **pair-addressed key**
(kind, both snapshots' path/content/import edges, rule, prompt version, token bound,
provider, model) — a second run over an unchanged branch makes zero API
calls, a moving merge-base cannot re-bill an unchanged semantic pair, and
the same head against a different base rejudges. A legacy judgment sends
both snapshots, roughly doubling that file's input tokens — accepted; it is
one call, and the alternative (two absolute verdicts subtracted) is both
costlier and less reliable.

## Calibration — the graded self-test (decisions D8, ACA-0012)

`aca context-footprint --self-test` runs the judge against golden fixtures in
`checks/context-footprint/fixtures/` and grades the result as cumulative
**qualification levels** (never to be confused with ENG-0151 routing tiers —
a tier selects a candidate model; a level records what one exact
`check + prompt version + fixture suite + provider + model` tuple
demonstrated):

- **`foundation`** — the contract/sanity minimum any qualified judge must
  pass: the enumerated union file as new (`new-violating`/`fail`,
  `relocation-not-design` or `duplicated-context`); the composed version as
  new (`new-compliant`/`pass`); enumerated → composed (`improved`/`pass`);
  composed → enumerated (`regressed`/`fail`).
- **`field`** — the judge-quality discriminator: the real image-trail
  `messages.ts` pair (550→356 lines, PR 786) must judge `improved`/`pass`
  **and** name the retained guard-enumeration/barrel debt as a residual with
  nonblank evidence and suggestion. A clean pass is a miss (blind to known
  debt); an absolute fail is a miss (punishes real improvement). This check's
  **required level is `field`**.

The manifest (`schemaVersion: 2`) declares levels, the required level, and
per-fixture expectations, checksums, and provenance; it is validated in full
before any judge call — a malformed or tampered package is a
configuration/integrity error (exit 2), never a judge miss. Levels execute
in order through the production concurrency-3 pool and stop after a failed
level; `achievedLevel` is the highest contiguous passing level, no partial
credit. `--json` emits one machine-readable qualification object (prompt
version, deterministic fixture-suite identity, achieved/required level,
per-level and per-fixture results — no fixture contents, no prompts).

This is simultaneously the negative control (proof the gate *can* fail) and
the prompt-change gate: **if a fixture assertion breaks, the prompt is wrong,
not the fixture.** Iterate on the prompt until all fixtures hold, then bump
the pinned prompt-version string (which invalidates the verdict cache by
construction). CI runs the self-test whenever the prompt or fixtures change;
requalify live whenever the prompt, rule, schema, manifest, or fixture
contents change. Production misses with agreed ground truth become immutable
fixtures extending the ladder; verdict instability means unqualified, never
"average the runs."

Full decision text, rationale, and downsides:
[ACA-0004](../decisions/ACA-0004-context-footprint-judgment.md) (D8),
[ACA-0013](../decisions/ACA-0013-comparative-judgment.md), and
[ACA-0012](../decisions/ACA-0012-graded-calibration.md).

## Consuming-repo wiring (reference, not part of this repo)

A consuming repo adds `aca.config.json` (include/exclude globs, tier map) and
a CI step running `aca context-footprint` **advisory first**. Promotion to
`--enforce` is a separate owner decision made on accumulated advisory
evidence, never bundled with adoption. Residual debt is scheduled, not
ambient: a separate consumer workflow may reconcile `--json` residuals into
tracked cleanup issues (see the adoption doc); that reconciler stays outside
ACA.
