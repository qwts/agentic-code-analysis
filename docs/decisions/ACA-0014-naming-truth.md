# ACA-0014: naming-truth — behavioral contract, three lies, host-enforced comparative mapping

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #14
**Builds on:** [ACA-0003](ACA-0003-suite-contracts.md) (suite contracts),
[ACA-0004](ACA-0004-context-footprint-judgment.md) (calibrated-judge
pattern), [ACA-0013](ACA-0013-comparative-judgment.md) (comparative
semantics, pair-addressed cache) — inherited, not varied.

## Context

Names that lie — `getUser()` that mutates, `isValid` that throws, names
describing a function three refactors ago — are the highest-tax
maintainability defect no mechanical tool can see: a linter checks a name's
format, never its truth. Backlog top-10 promoted this as the second check
(issue #14) because it reuses the calibrated-judge pattern end to end and
its evidence is file-shaped. Judging legacy files absolutely would recreate
the adoption tax ACA-0013 removed: a correct finding about an old
misleading name must not fail the change that merely touched the file.

## Decision

**Truth is a behavioral contract, not a style rule.** The authoritative
rule lives in [docs/standards/naming-truth.md](../standards/naming-truth.md)
(ACA-authored — no external canonical source, unlike
file-context-footprint) and is embedded verbatim at runtime. Scope is the
runtime public surface the file owns: the module claim of its path,
locally implemented exported functions/values/classes and their public
members. Exactly three failing criteria: `name-contradicts-behavior`,
`name-omits-side-effect`, `name-drifted`. Vague-but-not-false names never
fail; incidental logging/memoization/internal mutation/async mechanics and
programmer-error preconditions are not lies; behavior hidden behind an
import is never guessed. No regex/AST export inventory — a partial
inventory would silently miss valid export forms, so the judge identifies
the in-scope surface from the full content; mechanical derivation stays
limited to the import graph.

**Comparative mapping is host-enforced, finding by finding.** Each finding
carries `change` (`introduced | worsened | unchanged | improved`); host
code — never model prose — maps assessments to verdicts (table in the
[check design](../design/check-naming-truth.md)). Refinement over
ACA-0013's file-level mapping: a `regressed` file's findings are
*partitioned* — introduced/worsened block, unchanged/improved are retained
as residuals — so one new lie does not convert a file's whole pre-existing
debt into blocking evidence. Host-checked consistency invariants (new files
carry only `introduced`; improved/held carry no introduced/worsened; blank
required fields degrade) turn contradictory replies into non-cacheable
warns instead of trusted verdicts.

**Findings are symbol-shaped.** Every finding names the symbol and kind,
what the name claims, what the code does, quotable evidence, and an
advisory suggested truthful name (never applied). The check-local
`NamingTruthVerdict`/`NamingViolation` subtypes extend the frozen registry
contracts structurally; rich fields survive `--json`, and the concise
`evidence`/`suggestion` strings are derived for text output.

**Bounds and cache per ACA-0013**, with the pair-addressed key; the path is
a semantic key component here because the module name is itself judged
evidence. One file per request, stable-order pool of three shared by run
and self-test, `max_tokens` 4096, pinned prompt version (v2 at acceptance:
a cross-model self-application run read v1's "file I/O" literally and
failed read-only sourcing, so the criterion now says state-changing I/O). Calibration is
five synthetic ACA-owned counterfactual fixtures (design doc) asserting
assessment, verdict, criterion, and symbol; the truthfully-named twin of
the lying fixture is the negative control proving the judge rejects the
lie, not the throw.

## Consequences

The suite gains its second calibrated judge with zero shared-library
growth: comparison/import mechanics are forked from context-footprint and
trimmed (no growth line — line counts are footprint orientation), accepting
~200 lines of duplication to keep checks independent (ACA-0003 D1). The
finding-level `change` field costs the judge a harder task per finding but
buys residual partitioning on fails, which context-footprint lacks.
Suggested names are advisory prose only; automated renames, cross-file
naming consistency, and non-exported locals stay out of scope. Ships
advisory-first; enforcement promotion is a separate owner decision on
representative-repo evidence.
