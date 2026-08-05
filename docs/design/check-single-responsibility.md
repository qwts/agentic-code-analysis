# Design: `aca single-responsibility`

**Status:** Accepted — implementation plan approved on
[issue #16](https://github.com/qwts/agentic-code-analysis/issues/16)
(2026-08-05), adjustments recorded there. Consumes the
[suite design](suite.md) contracts and the comparative-judgment semantics of
[ACA-0013](../decisions/ACA-0013-comparative-judgment.md); no new ACA record —
ACA-0003 and ACA-0013 already define every contract this check uses.

## What it judges

Each changed file, against the repo-authored
[file-single-responsibility standard](../standards/file-single-responsibility.md):
is this one coherent responsibility — one actor, one reason to change? The
judge answers the standard's practical test: *who can ask for changes to this
file, and can any two of them ask independently?* This is the SRP judgment
that mechanical cohesion metrics (LCOM etc.) approximate numerically but
cannot actually make, because they cannot identify actors.

Comparison semantics are ACA-0013's, identical to context-footprint: a
**new** file (absent at the merge-base) is judged absolutely; a **legacy**
file is judged on the *direction* of the change (improved / held /
regressed), so pre-existing debt never blocks and worsening always does. A
rename stays legacy under its base path; a copy/extraction is new.

Tier: **T1 (judgment)** — routed through the consuming config's tier map
only; no model name appears in code.

## Boundary against `context-footprint` — the load-bearing distinction

- **Context footprint** judges the *cost of reading*: what must be loaded to
  work on this file safely.
- **Single responsibility** judges the *reasons for changing*: which
  independent actor, policy, or change pressure can force an edit.

These are independent axes. A small self-contained file can pass
context-footprint (minimal load-set) and fail SRP (two actors); a large but
cohesive protocol/composition file can fail context-footprint and pass SRP
(one owner). A file failing both produces **one file-level finding from each
named check**: criterion vocabularies are disjoint (`multiple-actors`,
`mixed-concerns`, `change-magnet` vs. the footprint check's five), the same
evidence is reported under the most specific SRP criterion only, and neither
check imports, suppresses, or paraphrases the other.

**Fixture reuse — evaluated and declined** (issue #16 requirement 4). The
context-footprint fixtures calibrate load-set, composition, and relocation;
reusing them here would blur the rubric boundary this section exists to
define, and couple two checks that must stay independent. This check ships
its own purpose-built fixture pair (below).

## Structure

An intentional local fork of the context-footprint module shape — checks
never import each other (ACA-0003 D1) and no fourth shared core library is
extracted:

- `index.ts` — normalize/dedupe paths, pair-addressed cache.
- `pool.ts` — the concurrency-3 worker pool production judging and
  calibration share.
- `comparison.ts` — new/legacy snapshots, merge-base, rename/copy semantics;
  the only module that runs git.
- `import-graph.ts` — imports and reverse importers per snapshot; no git, no
  judge policy.
- `judge-io.ts` — runtime rule loader, strict schema, prompts, deterministic
  verdict mapping.
- `calibration.ts` — manifest validation, expectation oracles, cumulative
  grading, suite identity (ACA-0012 fork bound to this check's criteria).
- `self-test.ts` — live graded calibration against the fixture manifest.

`JudgeClient`, change scope, verdict cache, adapters, `src/cli.ts`, and
`src/checks/context-footprint/**` are untouched.

## Judge input, per file

The system prompt embeds the **standard's text read from disk at runtime** —
never a paraphrase — plus judging mechanics (rubric-in-system). The user
turn carries the payload: comparison kind (and base path when renamed), one
growth line as orientation, per-snapshot import/imported-by **paths only**,
full head content, and full base content for legacy files. Importer paths
are evidence here because *consumer diversity* is how a second actor usually
shows up (a formatter imported by a retention scheduler is a smell the
content alone may hide).

Merge-base failure is a run-level config error (exit 2), never a per-file
"new" inference; unreadable per-file evidence degrades to a non-cacheable
`warn` (ACA-0013).

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "new-compliant | new-violating | improved | held | regressed | uncertain",
  "before_responsibility": "the practical-test answer for the base version; '(none — new file)' for new",
  "after_responsibility": "the practical-test answer for the head version",
  "comparison_evidence": "specific before-to-after evidence for the assessment",
  "head_violations": [{
    "criterion": "multiple-actors | mixed-concerns | change-magnet",
    "evidence": "names the actors/concerns/structure, quotable from the head version",
    "suggestion": "the concrete split or restructuring that would fix it"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

Effective-verdict mapping, gate policy in host code (ACA-0013, unchanged):

| Kind | Assessment | Effective verdict |
| --- | --- | --- |
| new | `new-compliant` | `pass` |
| new | `new-violating` (evidence required) | `fail` |
| legacy | `improved` / `held` | `pass`; head violations retained as residual debt |
| legacy | `regressed` (evidence required) | `fail` |
| either | `uncertain` | `warn`, cacheable |
| either | malformed, kind-incompatible, or evidence-free blocking assessment | `warn`, **not** cacheable |

Any introduced or materially worsened criterion is `regressed` even when
another area improved. The check returns a verdict subtype (`assessment`,
optional `basePath`, `residualViolations`); the shared `FileVerdict` is not
widened.

## Operational bounds and memoization

Identical to context-footprint: one file per request, concurrency 3,
`max_tokens` 4096, no sampling parameters; inputs normalized and deduplicated
before the pool; stable result order. Pinned prompt version
`single-responsibility-v1` — any prompt change fixes the prompt, never the
fixtures, and bumps the version. Cache at `.cache/aca/single-responsibility/`
with the pair-addressed key (prompt version, kind, both snapshots'
path/content/import edges with an explicit absent-base marker, rule text,
provider, model). Base ref/SHA, growth, and line counts stay out: a moving
merge-base cannot re-bill an unchanged semantic pair; the same head against a
different base rejudges.

## Calibration — the graded self-test (ACA-0004 D8, ACA-0012)

`aca single-responsibility --self-test` runs the ACA-0012 graded exam: a
`schemaVersion: 2` manifest declaring ordered qualification levels with
per-fixture checksums and provenance, validated in full before any judge
call (a malformed or tampered package is a configuration/integrity error,
exit 2, never a judge miss). Levels grade cumulatively through the
production pool — one comparative call per fixture, stop after a failed
level — and `--json` emits the machine-readable qualification record
(prompt version, deterministic fixture-suite identity, achieved/required
level, per-level and per-fixture results; no fixture contents, no prompts).

The **`foundation`** level (also the required level) judges purpose-built
fixtures (`checks/single-responsibility/fixtures/`), a line-item pricing
pair:

- **inline-policy pricing as new** — one small pure function where a
  marketing-owned promo percentage, a compliance-owned VAT rate, and an
  audit-checked rounding direction are all hardcoded —
  `new-violating`/`fail` with `multiple-actors`;
- **policy-injected pricing as new** — the same sequencing with the policy
  values taken as inputs; only a change to the computation itself touches
  the file — `new-compliant`/`pass`;
- **inline → injected legacy transition** (the policy owners move out; the
  file *grows*) — `improved`/`pass`;
- **injected → inline legacy transition** (the file *shrinks*) —
  `regressed`/`fail` with `multiple-actors`;
- **unchanged inline-policy legacy** — `held`/`pass` with required residual
  `multiple-actors` (grandfathered-debt calibration).

The improved transition grows and the regressed one shrinks — deliberately,
so the fixtures also calibrate "line counts are orientation, not the
decision." The dual-actor fixture is **footprint-clean by construction**:
the discount → tax → round-once steps interact, so colocating them is what
the context-footprint rule itself prescribes, and its only defect is
ownership. Two earlier cuts failed this bar and are recorded here as
calibration evidence: formatting + filesystem archival failed *both* checks
(hidden I/O drags real reading context), and a footer formatter embedding a
retention policy was CF-borderline — pass/fail flipped across repeated
runs. The pricing fixture passed context-footprint on every repeated run.

A **`field`** level needs a production-derived case — per ACA-0012 policy
the first production miss with agreed ground truth becomes an immutable
field fixture, with provenance and permission recorded in the manifest.
None exists yet; the gap is recorded in the manifest and `requiredLevel`
stays `foundation` until one lands, so passing today's exam is screening
evidence, not field authority.

An always-pass stub misses the negative controls, and the dual-actor file
doubles as the **cross-check discriminator**: run through
`context-footprint` with an explicit path it is expected `pass` (minimal
footprint), while this check fails it (`multiple-actors`) — the
demonstration that this check adds signal beyond the existing one. That run
is recorded as acceptance evidence in the PR; it creates no runtime
dependency between the checks.

## Consuming-repo wiring

Nothing new: one lazy registry entry, the fixture directory excluded in
`aca.config.json`, advisory-first adoption per the suite design.
