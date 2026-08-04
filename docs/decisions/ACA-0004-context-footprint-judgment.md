# ACA-0004: Context-footprint judgment — file-as-it-stands, load-set accounting, fixture-gated prompts

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** #4 (embodying issue; the why and review trail live in the design
review, [PR #1](https://github.com/qwts/agentic-code-analysis/pull/1) / #2)

## Context

Decisions D5 and D8 of the accepted
[check design](../design/check-context-footprint.md), consolidated into the
record whose issue builds them.

## Decision

**D5 — judge the file as it stands, selected by the change.** The diff
decides *which* files are judged; the verdict is about the file's current
state, informed by statically derived context (import edges, hunks, growth).
Load-set accounting (owner clarification, 2026-08-04): an import charges the
footprint only when the imported file must be *opened* to understand this
one — names at the boundary sufficing is the healthy case. A short file whose
comprehension leans on imports line-by-line has a large effective footprint
despite its length; that is the fragmentation edge case, not the norm. A leaf
file swept into the change set is judged on its own footprint, never a
neighbor's problem inherited through the diff. *Why:* the rule is a property
of files, not of diffs; judging diff quality invites relitigating history.
*Downside:* a PR can be failed for debt it merely touched, not created.
Accepted deliberately — that is how ratchets already work here, and `warn`
exists for the boundary.

**D8 — golden fixtures gate prompt changes.** `--self-test` judges in-repo
fixtures with asserted verdicts (seed pair: enumerated union → `fail`,
composed version → `pass`); a broken assertion means the prompt is wrong,
never the fixture. Prompt changes bump the pinned version string, which
invalidates the verdict cache by construction. *Why:* an LLM judge without a
regression harness drifts silently; the self-test makes prompt quality a
tested property and makes D2's per-provider support claim falsifiable.
*Downside:* fixtures can overfit — two are a floor, not a suite; every false
positive/negative found in real use becomes a fixture before the prompt is
touched. Fixture verdicts bill real API calls, so the self-test runs
on-demand and on prompt change, not per-PR.

## Consequences

`fail` stays reserved for criteria the rule text names; ambiguity is `warn`,
never `fail` — a judge that fails on vibes gets the gate disabled, a gate
that warns honestly earns `--enforce` promotion. The fixture set is expected
to grow; a calibration miss in production is a missing fixture first and a
prompt bug second.
