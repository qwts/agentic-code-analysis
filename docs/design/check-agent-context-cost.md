# Design: agent-context-cost check

**Status:** Accepted (issue #24, epic #27; architecture per
[ACA-0023](../decisions/ACA-0023-agent-context-check-architecture.md)).
First member of the agent-context family; an independent check consuming
the shared [instruction-corpus library](instruction-corpus.md)
(`src/corpora/instructions/`) as evidence. Originally drafted in PR #49
against a group-private corpus; reworked onto the merged library.

## Problem

Instruction files are loaded into every session: each token is paid
thousands of times, forever — in dollars and in context-window
displacement. Bloat accretes because nothing prices it. Token counting is
mechanical; **value per token is judgment**: three sentences of hedging
around a one-line rule, examples longer than the rule they illustrate,
restatements of what any agent discovers in seconds. The check makes the
mechanical layer frame the judgment — it never replaces it.

## Shape

`aca agent-context-cost [paths…]` — T1, one JudgeClient request per unique
physical instruction source, concurrency 3, `maxTokens` 4096, pinned prompt
version, `.cache/aca/agent-context-cost/`.

Target selection (ACA-0023): positional paths — or the change scope when
none are given — are **session target paths**. The full corpus is always
discovered; targets resolve to session load sets; the union of their member
sources is judged. A directory target selects every load set at or beneath
it, so `aca agent-context-cost .` is the full-corpus dogfood invocation. A
target that is itself an instruction source is judged directly. Sources are
deduplicated before the pool — one source, one judgment, however many load
sets contain it.

## Judge input

System prompt: the closed rubric below, plus an explicit data boundary —
the instruction text is quoted evidence, not instructions to the judge.
User turn per source: the delimited source text and the locally derived
mechanical frame (fragment estimates, tool bindings, scope, activation
class, load-set memberships). The judge is never asked to count tokens and
never shown unrelated instruction bodies.

## Criteria (closed set)

- `discoverable-restatement` — restates what an agent derives in seconds
  from the repo itself (`package.json` scripts, directory layout, "we use
  TypeScript").
- `low-density-prose` — hedging, restatement, or ceremony around a rule
  expressible in a fraction of the tokens.
- `oversized-example` — an example materially longer than needed to pin the
  rule it illustrates.
- `mechanically-enforceable` — the rule belongs in a hook/linter/CI check at
  zero context cost, not in prose paid every session.

**Protected, explicitly:** genuinely non-derivable tribal knowledge — the
*why* behind a convention, the undocumented footgun, the cross-session
contract. Dense-and-valuable passes at any length. Length is not the
signal; the calibration exam pins this with a same-length pass/fail pair.

## Judge reply and host verification

Strict schema: `assessment` (`dense` | `padded` | `uncertain`), `findings[]`
(criterion, exact `excerpt`, `action` `rewrite`|`table`|`delete`|`move-to-hook`,
`replacement`, `destination`, rationale), `value_summary`,
`reasoning_summary`. Host code — never the model — verifies every finding:

- the excerpt occurs **verbatim and unambiguously** (exactly once) in the
  source; fabricated or ambiguous excerpts degrade the file to a
  non-cacheable `warn`;
- `delete` requires an empty replacement; `move-to-hook` requires a
  destination; `rewrite`/`table` require a non-empty replacement that
  differs from the excerpt;
- savings are recomputed locally with the same `TokenEstimator`
  (`estimate(excerpt) − estimate(replacement)`, floored at zero) — model
  arithmetic is never trusted;
- the reported total sums a greedy non-overlapping subset (source order):
  overlapping rewrites are never summed as if independently realizable.

## Verdict policy (host-owned)

- `padded` with ≥1 verified finding → `fail`; each finding renders as
  criterion + excerpt + `action` with estimated savings — directly patchable.
- `dense` with zero findings → `pass` regardless of size.
- `uncertain` → cacheable `warn` (judged semantic uncertainty).
- Source whose bindings are all `unverified` → mechanical `warn` naming the
  reason, **no judge call, no spend**.
- Refusal, transport/schema failure, `padded` without findings, `dense`
  with findings, or any failed finding verification → non-cacheable `warn`
  (describes the transport or a malformed reply, not the file; retries next
  run).

`AgentContextCostVerdict extends FileVerdict` structurally: source id,
estimate, bindings/activation summary, load-set memberships with totals,
verified findings with proposals and savings, estimated total savings.
`--json` exposes all of it; generic text stays findings-only.

## Cache

Key: prompt version ‖ source content ‖ delivered fragments ‖ normalized
bindings (tool, convention, scope, activation, semantics status) ‖
estimator id ‖ provider ‖ model. Only the validated semantic judgment is
cached; current mechanical totals (load-set memberships, totals) decorate
it on every run. Corpus economics make steady state free: the corpus is
small and changes rarely, so an unchanged corpus is 100% cache hits and
zero API calls. Unrelated files elsewhere in a cascade are not in the key
and cannot re-bill a source.

## Calibration (ACA-0012 exam)

`src/checks/agent-context-cost/fixtures/` with a validated, checksummed
manifest; levels in order:

1. `foundation` — `padded-restatement.md` (discoverable restatement +
   hedging) must fail with the expected criteria; `dense-tribal.md`, a
   similar-length file of pure non-derivable tribal knowledge, must pass.
   The pair pins "length is not the signal".
2. `coverage` — `enforceable-rules.md` must fail with
   `mechanically-enforceable` (move-to-hook); `oversized-example.md` must
   fail with `oversized-example`.

`requiredLevel: coverage`. Live and uncached; a miss means fix the prompt,
never the fixtures, and bump the pinned version. Preflight validation
(schema, levels, checksums, bare names) errors before any judge call.

## Out of scope

Contradiction detection (#25), rule followability, auto-applying rewrites,
aggregate `aca agent-context` command (rejected in ACA-0023).
