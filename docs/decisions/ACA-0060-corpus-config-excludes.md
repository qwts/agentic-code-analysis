# ACA-0060: Corpus consumption honors configured excludes at discovery

**Status:** Accepted
**Date:** 2026-08-11
**Issue:** #60
**Extends:** [ACA-0023](ACA-0023-agent-context-check-architecture.md) D3 — a
revision of the instruction-corpus design doc, through the accepted-revision
path D2 requires

## Context

Full-corpus discovery in the agent-context checks ignored `aca.config.json`
`include`/`exclude`. Change scope is filtered through `filterScope`, but
`agent-context-cost` and `skill-information-architecture` scan the whole
repository tree — including `tests/fixtures/**` and
`src/checks/*/fixtures/**`, which the suite's own config explicitly
excludes. Fixture trees are deliberately padded and contradictory, so they
fail loudly and drown the real corpus: the first live dogfood run judged 41
sources of which ~30 were fixture files, wasting judge spend, burying real
findings, and creating phantom load-set classes from fixture directories.

`agent-rule-conflict` had already solved this check-locally (PR #53):
`buildArtifact` drops repo-origin sources matching the config excludes and
reports them in `--json`. Issue #60 posed the choice: replicate that filter
in every consuming check (option 1), or widen `CorpusRequest` so discovery
itself skips excluded paths (option 2).

## Decision

**`CorpusRequest` gains an optional `exclude` field — option 2.** Globs are
dot-inclusive (`**` crosses `.github`/`.cursor`; the platform matcher
remains as a fallback for syntax only it accepts), matched against every
root's root-relative POSIX paths, and applied in the listing pass: a match
is never interpreted, read, or tokenized by any adapter. The drop is
recorded as a corpus diagnostic — visible, not silent, the same posture as
the `.git`/`node_modules` skip.

**Consuming checks wire the suite config's `exclude` into the request by
default.** `agent-context-cost` and `skill-information-architecture` pass
`loadConfig(repoRoot).exclude`, so checks judge the corpus the config says
exists. `include` globs are not applied — real instruction files live at
the repo root and in dot directories that repo-scope includes typically do
not cover.

**Explicitly referenced content stays charged.** The exclusion governs
discovery candidates only. Content reached by explicit reference — e.g. a
Claude `@`-import of an excluded path — is still read and charged, because
the session genuinely loads it. Excluding it would understate real context
cost.

**`agent-rule-conflict` keeps its projection-level exclusion.** Its design
promises the excluded source list per path in `--json`; a listing-pass
exclusion cannot provide that, because an excluded candidate is never
interpreted as an instruction file at all. The check therefore does not
pass request-level excludes: one mechanism per visibility contract, not
two mechanisms stacked.

## Why

- One decision, all consumers inherit it. A check-local filter must be
  remembered by every current and future agent-context check; a request
  field is the pit of success, and the diagnostic keeps it honest.
- The library stays judgment-free and dependency-clean: `exclude` is
  caller-supplied data matched with the matcher the cascade already owns
  plus a `node:path` fallback — no config reading, no new imports from
  `core`.
- Discovery cost drops with the noise: excluded trees are skipped before
  reading and tokenization, not filtered after paying for both.

## Consequences

- A run after this change re-selects fewer sources on repositories with
  planted fixture trees; verdict cache keys are unaffected (excluded
  sources simply stop appearing), so no cache invalidation occurs.
- Phantom load-set classes from fixture directories disappear, changing
  the load-set membership decoration on surviving verdicts.
- The corpus request is no longer identical across consuming checks:
  two checks pass excludes, one deliberately does not. The divergence is
  documented in each check's design doc.
- A consumer that forgets to pass `exclude` regresses silently to
  full-tree discovery. Mitigation: the wiring is one expression per
  check, asserted by each check's tests.
