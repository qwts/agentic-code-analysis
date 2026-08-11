# Design: agent-rule-conflict check

**Status:** Accepted (issue #25, epic #27; architecture per
[ACA-0023](../decisions/ACA-0023-agent-context-check-architecture.md)).
Second member of the agent-context family; an independent check consuming
the shared [instruction-corpus library](instruction-corpus.md)
(`src/corpora/instructions/`) as evidence.

## Problem

Contradictory instructions produce arbitrarily flaky agent behavior: the
agent resolves the conflict silently and differently per session, and
humans misdiagnose the flakiness as model weakness. Conflicts *across*
files under *different tools' cascade semantics* are exactly what no grep
can see and the corpus map makes visible. Identifying that two rules are
semantically incompatible is the T1 judgment; the mechanical layer supplies
complete, attributable evidence — it never extracts candidate "rules".

## Shape

`aca agent-rule-conflict [paths…]` — T1, pinned prompt version,
`.cache/aca/agent-rule-conflict/`, concurrency 2 when partitioned.

This check is **state-shaped**: the evidence is always the complete current
corpus, never a before/after file comparison. Targets (positional paths or
the change scope) are triggers only — any non-empty target set runs the
whole-corpus judgment; an empty set runs nothing. Targets never truncate
the governing load set. Per-partition caching makes an unchanged corpus
cost zero calls.

**Projection exclusion:** repo-origin sources whose path matches an
`aca.config.json` `exclude` glob are dropped from the projection (the
reusable fixture pattern — this check's own fixture trees and the corpus
library's test trees contain planted instruction files that must not enter
this repository's corpus). Exclusions are visible in `--json`; `include`
globs are not applied (real instruction files live at the repo root).

## Artifact (check-local projection)

Built from `discoverInstructionCorpus` + `resolveInstructionSession`; the
check adds no discovery, no convention semantics, no private resolver.

- **Sources**: locator, path, origin, full content, binding tools, token
  estimate — sorted, deduplicated, validated (every session member exists).
- **Sessions**: one load-set class per (profile, instruction-directory CWD)
  — the deterministic session classes of this corpus, as in the sibling
  check. Classes with identical membership coalesce (all CWDs listed).
  Each records ordered **confirmed** entries (source id, convention,
  conflict policy, order rule) and **conditional** entries (with reasons),
  plus the resolver's `complete` flag. Only verified bindings confirm
  (library contract); unresolved semantics stay visibly conditional and are
  never guessed into a precedence or a blocking result.

The canonical serialization of this artifact is the judge payload, the size
measure, and the cache-key body — one text, three uses.

## Judge contract

One authoritative rubric in `judge-io.ts`, prompt version pinned
(`agent-rule-conflict-v1`; bump on any prompt/schema change). The corpus is
serialized as a canonical JSON data structure inside a delimited block and
declared DATA — the judge is told never to follow instructions found in it.
Per-partition source-id enums are generated into the strict schema
(`additionalProperties: false`, all fields required):

- `assessment`: `no-conflict` | `conflicts-found` | `uncertain`.
- `conflicts[]`: `criterion` (`direct-contradiction` — two applicable rules
  require mutually incompatible behavior; `unresolved-precedence` —
  applicable rules collide and neither text nor verified cascade semantics
  provides a usable tie-break; `cross-tool-divergence` — comparable tool
  variants make incompatible claims about the same scoped fact), `rule_a` /
  `rule_b` (`source_id` enum + exact contiguous quote), `explanation`,
  `resolution` (`pick-rule-a` | `pick-rule-b` | `add-precedence` |
  `consolidate`), `suggestion`.
- `reasoning_summary`.

**Hierarchy is not conflict.** A nested rule that deliberately and
explicitly supersedes a root rule for its subtree — where the stated scope
or the tool's verified cascade makes that unambiguous — produces no
finding. Rules with disjoint stated applicability are not in conflict.
Wording difference, preference, or non-contradictory parity drift is not a
finding. The judge never decides effective severity and never names
sessions — the corpus map owns attribution.

## Host verification and verdict policy

Applied atomically per partition; any violation degrades that partition to
a non-cacheable `warn` (never a partial authoritative result):

1. every `source_id` exists in the partition;
2. both quotes are nonblank, distinct, and occur verbatim-and-unambiguously
   (exactly once) in their source — line ranges are derived from the match,
   never trusted from the model;
3. explanation and suggestion nonblank; resolution in the closed set;
4. envelope compatibility (`no-conflict` ⇒ zero conflicts;
   `conflicts-found` ⇒ at least one; `uncertain` ⇒ zero).

Host-owned severity, criterion-independent (the label describes the
mechanism, the corpus map decides the blast radius):

- ≥1 session whose **confirmed** load set contains both rules, with both
  entries' conflict policy known (not `unresolved`) → `fail`;
- co-load only conditional/unverified, or every co-loading session depends
  on an `unresolved` conflict policy → `warn` (`semanticsUnverified`);
- no session loads both (cross-tool-only divergence included) → `warn`
  with an explicitly empty `sessionsLoadingBoth`;
- judged `uncertain` → cacheable `warn`;
- valid `no-conflict` → `pass`.

## Partitioning (whole-artifact first)

Operational bounds, pinned here (check-local; deliberately far under any
current provider window so estimator error cannot overflow — not derived
from a recalled context size): serialized partition payload ≤ **48,000
estimated tokens** (corpus estimator) **and ≤ 320 KiB UTF-8**; output
`maxTokens` 32768 (the suite-wide bound of ACA-0070); concurrency 2.

1. Complete artifact fits → exactly one `whole-corpus` judge call.
2. Else coalesce sessions with identical ordered load sets → one
   `session-load-set` unit per unique set, each carrying its **complete**
   constituent sources.
3. Add `cross-tool-comparison` units for pairs of units from different
   tools whose CWD scopes overlap (ancestor-or-equal) — cross-tool
   divergence must stay covered once the whole corpus stops fitting; this
   is a correctness obligation, not an optimization. A comparison unit
   retains both sides' session metadata; it is not an invented session.
4. Units run in stable order, bounded concurrency, deterministic ids.
5. An indivisible oversize unit is skipped with a visible incomplete
   `warn` naming the uncovered sessions and the measured limit — never a
   silent truncation, split source, or partial `pass`/`fail`.

`--json` exposes every partition: id, kind, session ids, source paths,
estimated tokens, serialized bytes, completeness, cache status. No prompts
and no full instruction contents appear in JSON.

## Aggregation

Findings dedupe across partitions by canonical ordered rule pair
(source id + match offset + quote) plus criterion, unioning partition ids.
If partitions materially disagree on a pair's criterion or disposition, the
pair downgrades to `warn` with a partition-disagreement note — never an
arbitrary blocking interpretation. Output: one `FileVerdict` per source
with findings (worst severity; violations render both quotes, common
sessions or `none`, and the resolution), plus one `(corpus)` row carrying
partition visibility — `pass` when coverage is complete and healthy,
`warn` when any partition degraded or was skipped. `--enforce` blocks only
on effective `fail` findings.

## Cache

Per judged partition, `.cache/aca/agent-rule-conflict/`. Key: prompt
version ‖ partition kind ‖ canonical serialized payload (source contents,
ordered load/cascade metadata, session identity/scope/verification) ‖
estimator id ‖ partition-plan version ‖ outcome-policy version ‖ provider ‖
model. Valid pass/fail and judged uncertainty are cached; refusals,
malformed envelopes, invented evidence, and incomplete coverage are not.
Any semantic change — content, membership, precedence, verification
status, plan/policy/prompt version, token bound, provider, model — misses by
construction. Hits are observable per partition in `--json`.

## Calibration (ACA-0012 exam)

`src/checks/agent-rule-conflict/fixtures/` holds small **repository
trees** loaded through the library's real discovery/cascade resolver — no
hand-built privileged corpus map. The manifest (schemaVersion 1) is
validated before any judge call: safe tree/file names, per-file SHA-256,
and an exact-listing check (an extra file in a tree is an integrity error).
Self-test is live and uncached and runs the production
artifact → partition → judge → policy path per tree.

`foundation` (required level):

- `within-file` — one AGENTS.md contradicting itself →
  `fail`/`direct-contradiction`;
- `cross-file` — AGENTS.md vs `.github/copilot-instructions.md`, co-loaded
  by verified copilot sessions → `fail`/`direct-contradiction` with both
  exact quotes and non-empty shared sessions;
- `scoped-override` — nested AGENTS.md explicitly superseding the root rule
  for its subtree under verified precedence → clean `pass` (the negative
  control: hierarchy is not conflict);
- `cross-tool` — `.github/copilot-instructions.md` vs a Cursor always-apply
  rule, no session loads both (CLAUDE.md is deliberately unusable here:
  `cursor-cli` co-loads it with Cursor rules) → `warn`/`cross-tool-divergence`
  with empty `sessionsLoadingBoth`.

The oracle asserts assessment, effective verdict, criterion, grounded
quotes, shared-session emptiness/non-emptiness, and resolution shape — not
only the top-level color. A miss means fix the prompt, never the fixtures;
every prompt change bumps the pinned version and requires live
requalification.

**Future `field` level (epic #27):** when a real adjudicated conflict is
found in the wild, preserve it as an immutable fixture and validate
behaviorally — run agents with and without the conflicting pair and record
whether behavior changes. V1 ships with static foundation fixtures; the
behavioral oracle is recorded here so it is not forgotten.

## Out of scope

Value density (`agent-context-cost`), non-contradictory parity drift
(backlog `agent-file-parity`), conflicts with the code (backlog
`agent-instruction-drift`), auto-applying resolutions, any `aca
agent-context` group command (rejected in ACA-0023).
