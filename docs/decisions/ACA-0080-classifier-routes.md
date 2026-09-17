# ACA-0080: Classifier routes are measured, not qualified — and enter as screening, never as judges

**Status:** Proposed
**Date:** 2026-09-17
**Issue:** [#80](https://github.com/qwts/agentic-code-analysis/issues/80)
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) D2 (provider-agnostic
JudgeClient) and [ACA-0012](ACA-0012-graded-calibration.md) (graded
qualification)

## Context

Issue #80 records the standing problem: `agent-context-cost` and
`skill-information-architecture` are qualified only on
`anthropic/claude-opus-5`, the CI spend policy keeps that key out of per-PR
screening, and two checks of twelve therefore have no CI coverage anywhere.
The 2026-08-18 bake-off failed every current-generation token-plan model, and
the misses were verified against opus transcripts as honest judgment gaps
rather than matcher or fixture defects. `glm-5.3` reads some fixtures well but
has no schema-enforcing route: z.ai caps at `json_object` platform-wide.

A different shape of candidate has since appeared: models that return typed
answers and calibrated probabilities instead of prose. TypeSafe's System One
family (Jev) is the current example. Screening one raises a question the suite
has not had to answer, because every route so far has been a chat model that
could in principle emit the verdict artifact.

Two facts decide it.

**The verdict artifact is generative, in every check.** All twelve verdict
schemas require `reasoning_summary`, and each finding requires prose the host
does not compute: `evidence`, `suggestion`, `meaningful_assertion`,
`test_patch`, `suggested_seam`, `proposal_text`, `rationale`, `suggested_name`,
`resolution`, `replacement`, `split_proposal`. A route that returns only typed
answers fails the strict-schema parse in `judgeOutcome`, degrades to a
non-cacheable warn, and scores zero on every fixture — for a reason that says
nothing about the quality of its judgment. `glm-5.3`'s blocker is the weaker
form of the same problem; a classifier route has it absolutely.

**The existing prefilter contract is proof, not probability.** Both
`seam-audit/prefilter.ts` and `failure-posture/prefilter.ts` skip a file only
when evaluation provably acquires no dependency and executes nothing; every
ambiguity resolves to unproven and goes to the judge. A calibrated probability
is not a proof. Dropped into that slot unchanged, a classifier would resolve to
unproven on everything it did not decide with certainty and save nothing.

## Decision

**A classifier route is measured on the classification axis, and that
measurement is never qualification.** `scripts/classification-score.ts` scores
the assessment/verdict call and the criterion labels from the `--self-test
--json` artifacts `calibrate.yml` already uploads, with generated prose
ignored. It reads recorded evidence only, changes no check's grading code, and
re-scores routes measured before it existed — including the bake-off artifacts,
which is how #80's "honest judgment gaps" claim becomes a number instead of a
reading of transcripts. Its output carries the disclaimer in its own table: a
route qualifies by the fused exam or not at all.

**Qualification levels stay where they are.** #80's reasoning holds and this
record does not reopen it: the levels are the claim the checks make to
consumers, and opus passing cleanly proves they are attainable.

**A route that cannot emit the verdict artifact is not admitted as a
JudgeClient.** The port stays frozen (ACA-0003 D2). No adapter may synthesize
the prose fields to satisfy the parser: a fabricated `evidence` or
`meaningful_assertion` would be a false oracle of exactly the kind
`test-honesty` exists to catch, and the suite would be publishing invented
remediation under a qualified route's name.

**Such a route may enter only as a screening stage, under an explicit
threshold policy, ahead of a qualified judge.** The published verdict remains
the qualified judge's, at the required level, so consumers get no weaker claim
than today. What changes is how many files reach it. This is a deliberate
departure from the proof-only prefilter contract and is why it needs a record:
a probability threshold accepts a measured false-negative rate in exchange for
spend, where the mechanical prefilters accept none. The threshold must be
evaluated on this repo's own corpus and stated as a number, not inherited from
a vendor cookbook.

## Why

#80's constraint is spend, not capability — the qualified route exists and
works. Screening attacks the constraint directly: most files in a real corpus
pass, a pass verdict is the cheap half of the exam, and the fail path that the
required levels actually stress still runs through the qualified judge.

Admitting a classifier as a judge instead would mean either lowering the levels
or fabricating the artifact. #80 already rejected the first. The second is
worse than the problem it solves.

Measuring the classification axis separately is what makes the screening
question answerable before any adapter is written. If a candidate's
classification is no better than the token-plan models the bake-off already
rejected, the cascade is not worth building and the measurement cost was one
script. If it matches opus on the pass majority, the threshold policy has
evidence behind it.

## Evidence (2026-09-16)

Added while this record is still `Proposed`, answering the question it set
itself: the threshold "must be evaluated on this repo's own corpus and stated
as a number." The candidate is `typesafe/jev-1.13.0` — the model string the
API returned, not the `jev-1` label requested.

**Two blockers recorded in #90 were wrong.** The JavaScript SDK is published as
`@typesafe-ai/sdk` (#90 searched `typesafe-ai` and read the 404 as absence),
and `docs.typesafe.ai` resolves. No wire contract had to be guessed.

**Classification axis, test-honesty fixtures, 10 runs.** Assessment 7–8/8,
verdict 8/8, criterion labels 4/4. One fixture (`unreviewable-snapshot`)
changes answer between runs on an identical payload, landing correct 8 times
in 10; every other fixture is stable. **A single self-test run is therefore too
noisy to set a threshold from** — a fact this record did not previously state,
and which matters because the exam is normally run once.

**Confidence, not probability, is the gating signal.** On the run that missed,
the losing label's *probability* was an unremarkable 0.51; its *confidence* was
0.318 against a floor of 0.822 across every stable fixture. Probability
describes the choice, confidence describes whether to trust it, and only the
second separates the error.

**Real corpus: 234 test files across 13 local repositories** (**partly
contaminated — see Corrections**) — 227 pass, 7
fail, at a cost of roughly $0.04 and under a minute wall-clock. Of the 7, all 7
are real on inspection, including two security tests asserting
`expect(true).toBe(true)` under the names `ST-302: repo privacy (simulated)`
and `ST-003: CI uses official actions (placeholder)`.

**False-negative rate: 0, against independent detection.** A mechanical grep
for tautological assertions over the same 234 files finds exactly three; the
route flagged all three. It also flagged four the grep cannot see — a test
named for a history limit it never exercises, a security test exercising
`JSON.parse` rather than the validator under test — so its recall strictly
exceeds the mechanical detector's. No known-bad file was passed.

**Confidence on real files is materially lower than on fixtures**, which are
roughly half the size. A 0.80 threshold settles ~5% of real files; 0.60 settles
~70%. The cascade's economics therefore live in a confidence band the fixtures
do not validate, and the fixture-derived gap at 0.70 does not transfer.
(**Every confidence number above is naive-framing — see Corrections.**)

What this does **not** establish: it covers one check; three
independently-confirmed positives is a thin base for a published threshold; the
227 passes were not audited, so subtle slop neither the route nor the grep sees
would not appear here; and no qualified judge was run over the same files, so
these are agreement and recall figures, not a measured false-negative rate
against opus.

## Consequences

- A classifier route can be compared against every route already measured,
  from artifacts already retained, without a JudgeClient adapter existing.
- The classification table is a new number that is not qualification and will
  be misread as qualification if quoted without its disclaimer. The script
  prints the disclaimer in-band for that reason.
- The graded exam short-circuits after a failed level, so artifacts from
  existing runs carry unreached fixtures with no verdict. A classification
  profile from such a run understates every level above the first failure. The
  table reports the unreached count rather than folding it into a ratio. A
  complete profile needs a non-short-circuiting self-test mode, which this
  record does not add.
- A screening stage introduces a false-negative rate the suite has never
  accepted before. Advisory-first posture and the qualified judge on every
  escalated file are the controls; the threshold is a published number, not a
  tuning knob.
- Nothing here qualifies any route or closes #80. It settles what a classifier
  candidate would have to prove and how it would be admitted if it did.

## Corrections (2026-09-16, same day)

Two defects in the measurement above were found after it was written. Both
move numbers this record relies on, so they are recorded here rather than
silently edited away.

**The corpus skipped a scope stage.** `scripts/jev-corpus.ts` applied the
check-local test-file globs but not the consuming repo's `include`/`exclude`
globs, which a real run applies first. In this repository that admitted
exactly seven planted calibration fixtures — `commit-coherence` and
`review-readiness` fixture trees, including one named `forgotten-debris` — as
though they were real code, and they sorted first, so they led the default
run. The local-repository figures above are contaminated to that extent: the
"234 real test files" were not all real, and because the run's per-file output
was not retained and the thirteen repositories were not recorded, the 7-fail
list and the 0-false-negative claim cannot now be re-derived from evidence.
They are withdrawn as measurements and kept only as the reason the sweep was
worth running. Fixed, with the two-stage selection extracted as `corpusFiles`
and pinned by test. The openclaw figures are unaffected: that repository has
no `aca.config.json`, so its exclude list was empty either way.

**The framing was naive, and it cost roughly half the settle rate.** Every
number above was produced by dumping the generative judge's prose rubric into
`state` and asking Choice questions whose every option description was `null`
— that is, asking the model to choose between `honest`/`dishonest` and
`pass`/`warn`/`fail` with no definition of any label. TypeSafe documents that
option descriptions, Score levels and Noul criteria all accept structure, and
that state should hold the material while the questions define the judgment.
Re-run with the material structured (`test_file`, `unit_under_test`,
`snapshots`, `blocking_criteria`) and every label described, on this
repository's 78 real test files:

| settle threshold | naive | structured |
| --- | --- | --- |
| >=0.70 | 46% | 71% |
| >=0.80 | 23% | 47% |
| >=0.90 | 3% | 21% |

Structured framing also costs ~20% less per file, because the prose rubric
preamble leaves `state`. On the calibration fixtures it lifts mean verdict
confidence from 0.688 to ~0.905.

**This retracts a conclusion drawn above.** The record blamed run-to-run
instability on the model, and inferred from it that "a single self-test run is
too noisy to set a threshold from." Under structured framing the fixture that
flipped (`unreviewable-snapshot`) settles at 0.95 confidence, and the
low-confidence readings that produced the noise were the model responding
honestly to an underspecified question. The instability was ours.

**A design defect the comparison exposed.** Questions are evaluated
independently, so nothing makes `assessment` and `verdict` agree: a run can
answer `verdict: fail` at 0.95 while answering `assessment: honest`. Asking
both as free-standing Choices invites exactly that contradiction. The
composite-scoring shape — ask the four criteria atomically, derive assessment
and verdict in code — is coherent by construction and is what a real screening
adapter should do. Not built here.

**Full upstream openclaw sweep** (naive framing, 15,910 files screened of
16,111, $3.69): pass 15,832, warn 9, fail 69, 201 unscreenable (1.3%, all
`max_tokens_exceeded` — `buildEvidence` bounds companion context but not the
test file itself). Settle 50% at 0.60, 21% at 0.70, 4% at 0.80.

**What this means for the record's question.** The threshold "must be
evaluated on this repo's own corpus and stated as a number" — and it still
must, but no number measured so far is a fair estimate of what this route can
do, because none of them asked the question well. A threshold published from
naive-framing evidence would understate the route by roughly half.
