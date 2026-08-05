# ACA-0020: Diff-fixture corpus and the canonical diff artifact

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #20 (cross-cutting decision 1 of the check backlog; blocks
`review-readiness` #21 and `commit-coherence` #22)
**Extends:** [ACA-0004](ACA-0004-context-footprint-judgment.md) D8's
calibration corpus to before/after pairs; [ACA-0012](ACA-0012-graded-calibration.md)
graded manifests gain a pair-fixture kind.

## Context

The calibration harness knows one fixture shape: a file judged as it stands
(ACA-0004 D8), graded per ACA-0012. Diff-scoped checks judge a *change*, so
their fixtures are before/after trees plus expected verdicts — a different
corpus format, storage layout, and assertion shape. Two checks are queued
behind this decision; building the corpus inside the first of them would
couple corpus design to one check's needs and force the second to either
import a sibling check (forbidden by ACA-0003 D1) or fork the format.

Diff checks also need a shared answer to what a judge's user turn contains
and how big it may get — the diff-scoped analogue of what ACA-0004 decided
for file checks.

## Decision

**D1 — Pair fixtures are before/after file trees.** A case lives at
`src/checks/<check>/fixtures/<case-dir>/{before,after}/` with real files at
repo-relative paths, so one case spans multiple files naturally. Expected
verdicts attach in the check's graded `manifest.json` (pair schema,
`schemaVersion: 1`): levels and `requiredLevel` per ACA-0012, and per case a
`dir`, a `level`, and an `expect` block — the expected effective verdict plus
the criteria that **must all** be found, each with the file and (optionally)
the exact head line the finding must anchor to. Assertion is all-of on
criteria (a pair fixture built to demonstrate two smells is missed if either
goes undetected), any-of remains expressible by listing one criterion.

**D2 — The self-test computes the fixture diff in memory.** An LCS line
diff over the before/after trees produces the same canonical artifact that
production builds from git; fixtures carry no `.git`, no patch files, and no
checksums — the diff is recomputed from the trees on every run, so the exam
always tests exactly what is on disk. Loading, validation, and tree diffing
live beside the registry as harness infrastructure
(`src/checks/pair-fixtures.ts`), shared by every diff check's self-test and
usable without any judge call.

**D3 — One canonical diff artifact for all diff checks.** A shared module
(`src/core/diff-artifact.ts`) defines the artifact — ordered per-file diffs
with status (`added`/`modified`/`renamed`/`deleted`), rename identity, and
hunks whose lines carry explicit old/new line numbers — with two
constructors: from git (merge-base of the CLI base ref vs the working tree,
rename detection on, restricted to the CLI-selected scope) and from
in-memory trees (fixtures). Checks consume the artifact; no diff check
parses git output or invents a second diff format.

**D4 — Diff judge I/O convention.** A diff check's user turn is the
artifact rendered as a unified-style payload in which every context and
added line is prefixed with its **head line number** — the judge anchors
findings to numbers it can see, and the host validates every returned
anchor against the artifact's added-line index (context lines orient, only
added lines are reportable). The payload is bounded at
**120,000 characters** (`MAX_PAYLOAD_CHARS`, one bound all diff checks
inherit). Files are included whole in artifact order; a file whose rendering
would overflow the remaining budget is **omitted whole** and the render
names every omitted file with its hunk ranges. Omission is never silent:
material left unjudged must surface as `warn` verdicts naming what was not
judged — a bounded run can still fail on what it saw, but it can never
fully pass.

## Consequences

`review-readiness` and `commit-coherence` build on one corpus format, one
artifact, one payload convention; the file-fixture path is untouched (zero
behavioral change to `context-footprint --self-test`).

Downsides, accepted:

- No per-file checksums in the pair corpus (unlike ACA-0012's file
  manifests). Tampering with a fixture tree changes the computed diff and
  the expectations then miss — self-defending in effect, but a corrupted
  case reads as a judge miss rather than the integrity error the file
  corpus would raise. Revisit if a pair fixture ever fails mysteriously.
- The greedy skip-and-continue bound can omit an early oversized file while
  still including later small ones. Deterministic and coverage-maximizing,
  but the omission list, not payload order, is the source of truth for what
  was judged.
- The in-memory LCS diff may draw hunk boundaries differently than git for
  pathological inputs. Irrelevant to correctness — fixtures never take the
  git path, and both constructors feed the same renderer — but payloads for
  the same nominal change may differ cosmetically between the two sources.
- `deleted` status exists in the artifact for tree parity, while production
  scope (`--diff-filter=d` in change scope) never selects deleted files;
  the status is exercised only by fixtures until a check needs deletions.
