# ACA-0012: Graded calibration — qualification levels, validated exam, machine-readable evidence

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #12
**Extends:** [ACA-0004](ACA-0004-context-footprint-judgment.md) D8 (fixture-gated
prompts stand; the exam gains grades) under
[ACA-0013](ACA-0013-comparative-judgment.md)'s comparative semantics.

## Context

Measured 2026-08-04: two judges — `claude-opus-5` and
`Qwen/Qwen3-235B-A22B-Instruct-2507` — both aced the then two-extreme
self-test with perfect verdict stability, then stably *disagreed* on the
first real file either met (`messages.ts` post-improvement: opus reported the
retained guard-enumeration/barrel debt across three fresh runs; Qwen returned
a clean pass across four). Ground truth was known — the residual debt is real,
author-acknowledged, and scheduled. The self-test proved judge *sanity*, not
judge *quality*: a model can pass the extremes while blind to the
intermediate case the rule generalizes to. D8's own recorded downside
("fixtures can overfit — two are a floor, not a suite") arrived on the first
day of real use.

## Decision

**Qualification levels, not routing tiers.** The calibration suite is a
graded exam of named, cumulative *qualification levels* — `foundation` (the
four contract/sanity cases from ACA-0013) and `field` (the
production-derived case that discriminates whether a judge still detects
subtle residual debt after a genuine improvement). ENG-0151's T1/T2/T3 select
a candidate provider/model; a qualification level records what one exact
`check + prompt version + fixture suite + provider + model` tuple
demonstrated. No model allowlist in source, no automatic config mutation —
the dated disagreement above is evidence for the fixture, never a model name
to encode.

**The manifest is a validated exam.** `manifest.json` is a versioned object
(`schemaVersion: 2`) declaring ordered unique levels, a `requiredLevel`, and
fixtures carrying their level, comparison payload, expectation, checksums,
and provenance. It is validated in full — known levels/assessments/criteria,
unique names, at least one fixture per level, bare in-directory file names
only, files present and checksum-clean — **before any judge call**. A
malformed package is a configuration/integrity error (exit 2), never a judge
miss and never a vacuous qualification.

**The field oracle rewards improvement and demands the residual.** Under
comparative semantics the field fixture requires `improved`/`pass` *plus* a
residual finding among the accepted criteria with nonblank evidence and
suggestion. A clean `improved` misses (blind to known debt); an absolute
`fail` misses (punishes the real 550→356 improvement). Both failure modes
observed in the wild are thereby encoded.

**Cumulative grading with bounded spend.** Levels run in order through the
production concurrency-3 pool; a level passes only when every fixture passes
every declared expectation; `achievedLevel` is the highest contiguous passing
level (no averaging, no partial credit); execution stops after a failed level
— higher results cannot repair a lower miss and would only add spend. The
self-test stays live and uncached; one comparative call per fixture.

**Qualification is machine-readable and pinned to its exam.** `--json`
applies to `--self-test` and emits one object: check/provider/model, prompt
version, a deterministic fixture-suite identity (hash of prompt version,
rule, manifest, and referenced fixture contents), achieved/required level,
qualified boolean, and manifest-ordered per-level and per-fixture results —
no fixture contents, no prompts. Exit semantics are unchanged: 0 only at the
required level, 1 on a miss even without `--enforce`, 78 without
credentials, 2 for usage/invalid calibration.

**Policy.** Production misses with agreed ground truth become immutable
fixtures; verdict instability means *unqualified*, never "average the runs."
Requalify live whenever the prompt, rule, schema, manifest, or fixture
contents change. Passing `foundation` alone is screening evidence, not
authority for context-footprint enforcement or ENG-0160 ratchet
adjudication — this check's required level is `field`.

**Provenance and permission travel with the fixtures.** The vendored field
snapshots carry immutable references (image-trail PR 786; base
`dce6e9c3…`/blob `b065a475…`, head `ef4f8bc3…`/blob `ff84d940…`, blob-verified
against the source), local SHA-256, the source license, and the copyright
holder's written-permission reference. The self-test remains fully offline.

## Why

Qwen qualified on the exam and failed in the field, on the first real file it
met — the extremes cannot certify the middle. Grading turns a binary
qualified/not into evidence a consumer can route on, and encodes the
hand-measured finding so it never has to be relearned. Cumulative-with-stop
keeps the spend proportional: a judge that cannot pass the contract cases
earns no field call.

## Consequences

Downsides, accepted: the field level bills a fifth live judgment per
qualification run; the vendored fixture is proprietary source that cannot be
regenerated from this repo and depends on a recorded permission grant; a
single field fixture is a narrow discriminator — the ladder must grow with
each future adjudicated disagreement; and model evidence stays dated and
issue-bound, so operators re-measure instead of trusting folklore.
