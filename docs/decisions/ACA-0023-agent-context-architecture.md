# ACA-0023: Agent-context check group — independent checks over one group-private evidence package

**Status:** Accepted — acceptance is the approving human review of the PR
that merges this record (AGENTS.md workflow: PRs need one approving human
review; this record cannot reach `main` without it).
**Date:** 2026-08-05
**Issue:** #23 (embodying issue; children #24, #25 under epic #27)
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) D1 — narrowly, see below.

## Context

The agent-context check group judges instruction files (AGENTS.md, CLAUDE.md,
copilot/cursor/windsurf rules, skills front matter) — content paid for by
every agent session. Two checks are queued behind one shared question:
`agent-context-cost` (#24, value per token) and `agent-rule-conflict` (#25,
contradictions per session load set). Both need the same expensive evidence —
discovery across tool conventions, cascade/precedence resolution, token
accounting — and neither needs the other's judgment. This is the suite's
first concrete case of the check-group architecture question raised in the
backlog and the seam-audit design's shared-evidence note: one evidence pass,
many judges.

## Decision

**Independent commands sharing one group-private evidence package.**

- `aca agent-context-cost` and `aca agent-rule-conflict` are ordinary,
  independently invocable checks: own tier, own JudgeClient use, own prompt +
  calibration exam, own verdict mapping, own `.cache/aca/<check>/` namespace,
  standard 0/1/2/78 exit codes and `--json` per command.
- Both depend one-way on `src/check-groups/agent-context/corpus/`; neither
  imports the other. The package is judgment-free evidence only:
  deterministic discovery, convention resolution, session-load-set
  construction, and token estimation. It contains no prompt, criterion,
  verdict policy, JudgeClient, provider, or verdict-cache behavior, and
  imports no check, CLI, provider SDK, or core cache code.
- **Narrow extension of ACA-0003 D1**, not a fourth generic core library. D1's
  phrase "checks share only three narrow core libraries" is extended — not
  silently reinterpreted — to: checks may additionally share a
  human-approved, judgment-free evidence library outside `core/` when it has
  a data-only API and the import restrictions above. `JudgeClient`, change
  scope, verdict cache, `Check`, `CheckContext`, `FileVerdict`, CLI exit
  codes, and every existing check remain unchanged.
- `CheckContext.files` gets a check-local interpretation inside this group:
  they are **session target paths** (which sessions are we costing?), not a
  whitelist of instruction files. The corpus is always discovered in full;
  targets select which session load sets — and therefore which instruction
  sources — are judged. An unchanged root AGENTS.md is evidence whenever a
  changed source file selects a load set containing it. This reads the frozen
  interface, it does not widen it.
- **No `aca agent-context` aggregate command in v1.**

## Rejected alternative: an `aca agent-context` group command

Analyzed concretely, not dismissed:

- It would save one cheap filesystem/tokenization pass — and nothing else.
  The per-source and per-load-set judge calls, the expensive part, are
  distinct judgments with distinct rubrics and cannot be shared.
- It would require a new multi-member registry/dispatcher, one-tier-or-routed
  client policy for members, partial-result semantics, targeted self-tests
  (`--self-test` of what, exactly?), a new top-level JSON envelope carrying
  every member's result and status, and an explicit exit-code reduction order
  (usage 2 > incomplete enforce 78 > any fail 1 > 0) in which mixed failures
  must stay visible even when one code wins.
- Verdicts would still need per-member cache namespaces and keys — rubrics
  differ, so a "group cache" buys nothing. Evidence can be shared in memory
  within one invocation either way.

A second filesystem scan is cheaper than coupling two judgment units, result
shapes, self-tests, and failure states. Revisit only with measured evidence
that the scan matters.

## Why

The suite's boundary rule is *share mechanically derived evidence, never
judgment*. The corpus is mechanical and expensive to specify (per-tool
cascade semantics, verified against primary docs); the judgments over it are
cheap to keep separate and costly to merge. Keeping the public `aca <check>`
grammar means consumers, CI, and the cache learn nothing new.

## Consequences

Downsides, accepted: a full-corpus discovery runs on every member-check
invocation (bounded, local, no judge calls — measured as negligible);
"group-private" is a convention the import graph must uphold (tests assert
the corpus package imports no judge/check/CLI code); and a future third
member that needs judged evidence — not mechanical evidence — will not fit
this package and must not be forced into it. Each member check's own cache
key must include the canonical slice of corpus evidence it judged (content,
delivered fragments, bindings, estimator identity) so corpus changes
invalidate correctly; a member that keys on less silently serves stale
verdicts.
