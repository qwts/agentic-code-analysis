# ACA-0023: Agent-context check architecture — independent checks over a shared evidence library

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #23 (cross-cutting decision 2 of the check backlog; blocks
`agent-context-cost` and `agent-rule-conflict`)
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) — narrowly supersedes
one phrase of D1, below.

## Context

Several queued checks judge the same expensive evidence. The agent-context
family all needs the instruction-file corpus map (discovery, cascade
resolution, token accounting); the decoupling/seam family shares
dependency-inventory evidence, which the seam-audit design explicitly
recorded and deferred to this decision. The backlog (cross-cutting
decision 2) requires deciding, before the first such check is designed,
whether the architecture is (a) one `aca <group>` command running member
judges over a single evidence pass, or (b) fully independent checks
sharing a library. #23 provides the concrete case: the instruction-corpus
library, with two checks queued behind it.

ACA-0003 D1 froze loose coupling: one CLI entrypoint, checks never import
one another, and — as written — checks "share exactly three libraries"
(the `core` trio). A shared evidence library is a fourth shared thing;
D1's letter forbids it even though its intent (no coupling through
siblings, narrow core) does not.

## Decision

**D1 — Agent-context checks are independent, ordinary CLI checks that
share one judgment-free evidence library.** `aca agent-context-cost`,
`aca agent-rule-conflict`, and later members are registered like any other
check. "Agent-context" is a family/taxonomy label, not a CLI execution
primitive. Each member keeps its own tier, JudgeClient use, prompt,
calibration self-test, verdict mapping, and `.cache/aca/<check>/`
namespace. `--json` and exit codes remain exactly per command; there is no
aggregate output, no group exit code.

**D2 — Shared evidence libraries are permitted under narrow conditions,
superseding ACA-0003 D1's phrase "share exactly three libraries" — and
only that phrase.** Two or more checks may share a human-approved,
judgment-free evidence library outside `core` when it: has a data-only
API; imports no check, CLI, provider, cache, prompt, or verdict code; and
has an accepted design doc. Everything else in D1 stands unchanged:
checks still never import one another, and `core`'s three interfaces stay
frozen. The prior seam-audit note (a shared evidence pass must not be
created silently) is honored: this record is the explicit creation.

**D3 — The instruction-corpus library is the first such library.** It
lives at `src/corpora/instructions/` with the API, model, and limits in
[docs/design/instruction-corpus.md](../design/instruction-corpus.md);
convention semantics are pinned in
[docs/references/instruction-conventions.md](../references/instruction-conventions.md).
#23 itself ships no check: no JudgeClient, no VerdictCache, no CLI
command, no registry entry.

**D4 — Cache composition for future members.** Evidence may be shared in
memory within one invocation, but judge verdicts are never shared across
rubrics. Each member keeps its own VerdictCache namespace and key; a
"group cache" would buy nothing since the costly artifact is the
per-rubric verdict. A member's semantic key includes only the canonical
corpus slice it actually judges: session profile(s), ordered
contributions, verification status, relevant token-estimator identity and
counts, plus the usual prompt/rule version, provider, and model.

## Why

- The judge calls are the cost. A group command would deduplicate one
  small filesystem/tokenization pass but none of the distinct per-file
  and per-session judgments — the library deduplicates the same pass with
  none of the new machinery.
- Independent checks compose with every existing contract for free:
  ACA-0003's CLI shape, JSON envelope, exit codes, advisory/enforce
  semantics, and D7 caching apply per command with zero new decisions.
- Tier routing stays per check. Members may legitimately need different
  tiers/models; a group would force one client or invent multi-client
  routing inside a single command.

## The rejected alternative, concretely

An `aca agent-context` group command running member judges over one
evidence pass would require: a new multi-member registry/dispatcher;
either one tier/client for all members or multi-client routing;
partial-result semantics when one member fails or lacks credentials;
targeted self-test invocation per member; and a new public JSON envelope —
top-level group plus every member's result/status. Its exit code would
need an explicit reduction order (usage/config `2` > incomplete enforce
run `78` > any effective fail `1` > `0`), and mixed failures would have to
stay visible even when one code wins. Verdicts would still need per-member
cache namespaces and keys. All of that machinery purchases only the
shared evidence pass the library already provides.

## Consequences

- `agent-context-cost` and `agent-rule-conflict` unblock: each is an
  ordinary check whose design references the corpus contract instead of
  defining discovery.
- The suite gains a fourth shared surface. That is a real coupling cost:
  a breaking corpus-model change now fans out to every consuming check.
  Mitigation: the API is two functions over readonly data, changes go
  through an accepted design revision, and consumers pin expectations in
  their own calibration fixtures.
- Downside of rejecting the group: a user running three agent-context
  checks pays the corpus discovery pass up to three times (one per
  process). Accepted — the pass is bounded local I/O plus tokenization,
  orders of magnitude cheaper than one judge call, and process-level
  memoization can be added later without changing any contract.
- Downside of D2's precedent: "narrow conditions" will be tested by the
  next family (dependency inventory). The conditions are written to be
  checkable (data-only API, forbidden imports, accepted design) precisely
  so that review can be mechanical.
- The suite's first runtime dependencies land (`yaml`, `js-tiktoken`,
  exact-pinned) — accepted in the design doc; checks and `core` remain
  dependency-free.
