# ACA-0013: Comparative judgment — direction of change for legacy files, pair-addressed cache

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #13
**Supersedes:** [ACA-0004](ACA-0004-context-footprint-judgment.md) D5's
absolute-state semantics for files that existed at the merge-base; extends
[ACA-0003](ACA-0003-suite-contracts.md) D7's cache key to the comparison pair.

## Context

The first production verdicts (image-trail PR 786, 2026-08-04) demonstrated
D5's accepted downside in its worst form: a PR that substantially improved
`messages.ts` (550→356 lines, unions composed into a domain-owned module)
still received a `fail` for older debt predating the change. The verdict was
factually correct and still the wrong incentive — an agent optimizing against
that gate either explodes PR scope with unrelated cleanup, avoids legacy
files, or learns that red is normal and stops reading verdicts. The consuming
repo's size ratchet already solved the same problem by classifying the
change (`oversized-grew` fails, `oversized-reduced` passes), not the state.

## Decision

**Judge the direction of change for legacy files; absolute state only for
new ones.** Every judged file is a *comparison*: `new` (head snapshot only)
or `legacy` (base and head snapshots — path, content, import edges per
side), resolved against the merge-base once per run with rename detection.
A rename stays legacy under its base path; a copy/extraction is new. One
comparative judge call per file returns an assessment the host maps to the
effective verdict:

| Kind | Assessment | Effective verdict |
| --- | --- | --- |
| new | `new-compliant` | `pass` |
| new | `new-violating` (named evidence required) | `fail` |
| legacy | `improved` | `pass`; remaining violations retained as residual debt |
| legacy | `held` | `pass`; remaining violations retained as residual debt |
| legacy | `regressed` (named evidence required) | `fail` |
| either | `uncertain` | `warn`, cacheable |
| either | malformed, kind-incompatible, evidence-free blocking assessment | `warn`, **not** cacheable |

A held-but-still-violating legacy file passes exactly like an unchanged
grandfathered ratchet entry; any introduced or materially worsened criterion
is `regressed` even when another area improved, so new debt cannot be netted
against cleanup elsewhere. Residual debt is structured (`residualViolations`
on the check's verdict subtype), nonblocking, rendered as a finding, and
counted separately — never smuggled through `warn` or free text. `--enforce`
blocks only effective `fail`. The registry's shared `FileVerdict` is not
widened; the subtype extends it structurally.

**The cache key is the pair.** Comparison kind, both snapshots' path,
content, and import edges (explicit absent-base marker), rule text, prompt
version, provider, model. Base ref/SHA, hunks, and line counts stay out:
identity-independent or derived. The same semantic pair hits when the
merge-base moves; the same head against a different base rejudges. Inputs
are normalized and deduplicated before the worker pool.

**Refinements over the issue-#13 plan, decided during implementation:**

- Diff hunks left the judge payload. With both snapshots present they are
  derivable redundancy (for new files they duplicated the entire content);
  the growth line remains as orientation. Removes, rather than re-accepts,
  D7's cached-verdict-vs-current-hunks inconsistency.
- A well-formed `uncertain` caches as `warn`. v1's ambiguity-`warn` was
  cacheable; a non-cacheable `uncertain` would re-bill every ambiguous
  legacy file on every push, violating D7's zero-cost-unchanged guarantee.
  Non-cacheable stays reserved for what describes the reply, not the pair.
- An unresolvable merge-base is a run-level `ConfigError` (exit 2), never a
  per-file "new" inference; an unreadable per-file snapshot degrades to a
  non-cacheable `warn`.

**Cleanup-issue reconciliation stays outside ACA.** The suite emits
verdicts; a consuming repo's trusted, least-privilege workflow deduplicates
one tracked cleanup issue per `check + normalized path` from `--json`
residuals (adoption doc records the contract). No GitHub tokens, issue
mutation, or mutable URLs enter ACA or its cached verdicts.

## Consequences

Greenfield stays honest, the line holds against regression, and improvement
short of perfection is rewarded instead of punished — the debt inventory
builds itself from residuals rather than taxing every touch. Costs: legacy
files send two snapshots per judgment (roughly double input tokens);
`--json` consumers see new fields (`assessment`, `basePath`,
`residualViolations`); prompt v2 invalidates the verdict cache by
construction. The calibration self-test now asserts the transition
(new-violating, new-compliant, improved, regressed, and
improved-with-required-residual on the real image-trail pair), which keeps
issue #12's judge-quality discrimination intact under the new semantics.
