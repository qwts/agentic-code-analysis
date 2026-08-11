# Design: the agentic-code-analysis suite

**Status:** Accepted 2026-08-04; superseded where the decision records below
say so.
**Reviewed against:** [ENG-0012](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0012-decision-priority-order.md)
(security → compliance → agentic development → human developers).

## Scope

A suite of small, loosely coupled CLI tools that run **semantic, model-judged
checks on code structure and maintainability** — the class of judgment that
mechanical linters and ratchets structurally cannot make. It runs in two
environments with one interface: as a CI gate, and inside an agent's dev loop
as fast advisory feedback.

The first tool is `context-footprint` — it judges changed files against the
[file-context-footprint standard](../standards/file-context-footprint.md)
(one coherent concept per file, minimal context footprint; the boundary is
contextual completeness, not line count). See
[check-context-footprint.md](check-context-footprint.md).

**Relation to ENG-0002.** That record set direction: per-language natives and
ratchets as the enforcement layer; a central cross-repo instrument deferred.
This suite does not reopen that — it is the *complement*: ratchets catch the
symptom (a number moved), a semantic judge catches what ratchets provably
cannot (relocation dressed as design). The contract for a consuming repo is
conjunctive: **a change is good when it passes the ratchet AND the semantic
check.** Neither replaces the other.

**Out of scope** (each would be its own tool or repo later): bug-finding and
security review (existing review tooling owns that), formatting/style,
auto-fixing, dashboards or trend history, PR-comment bots. This suite emits
verdicts; how a repo surfaces them is the consumer's business.

## Non-negotiable properties (the declarations, made concrete)

1. **Agent context efficiency is the prime directive.** Output is findings,
   nothing else: no banners, no progress art, no restating of inputs. A clean
   run prints one line. Costs are bounded by design: judge only changed files,
   memoize verdicts by content hash, share one cached prompt prefix across a
   run.
2. **Commonly trained interface.** One entrypoint, subcommand per check
   (`aca <check>` — the `git`/`npm` shape every model already knows), GNU-style
   flags, `--help` per level, `--json` for machine consumption, sysexits-style
   exit codes. No novel invocation grammar to learn.
3. **Dual environment, one behavior.** The same command runs locally
   (advisory, always exit 0) and in CI (`--enforce`, exit 1 on fail). CI is
   configuration, not a separate code path.
4. **Loose coupling.** Checks never import each other. They share exactly
   three narrow libraries — change scope, judge client, verdict cache — each
   independently usable and replaceable. Adding a check touches no existing
   check.
5. **Model-interchangeable judging.** Checks talk to a `JudgeClient`
   interface, never to a vendor SDK. Adapters: Anthropic, OpenAI, Qwen, and
   local (OpenAI-compatible endpoint, e.g. LM Studio / Ollama). Provider and
   model are configuration.

## Architecture

```
aca <check> [--enforce] [--json] [--base <ref>] [--self-test] [paths…]

src/
  cli.ts                  dispatcher: parse args, route to a check, map exit code
  core/
    config.ts             aca.config.json (scope globs, tier -> provider/model map)
    change-scope.ts       changed files vs merge-base(origin/main), include/exclude globs
    judge-client.ts       the JudgeClient port; adapters/ holds one file per provider
    verdict-cache.ts      content-addressed memoization of judge verdicts
  checks/
    registry.ts           check contract + name -> loader map (one entry per check)
    context-footprint/    first check — prompt, schema, verdict mapping, fixtures
    naming-truth/         later check — same shape, forked mechanics (checks stay independent)
```

Language (decided 2026-08-04, issue #3; publication boundary superseded by
ACA-0059): TypeScript 7 on Node ≥ 24 — erasable-syntax-only `.ts` runs directly
via Node's native type stripping during development. npm packaging may emit
ESM JavaScript into an ignored `dist/` tree; generated JavaScript is never
committed. `tsgo` type-checks in CI. Tests use Node's built-in runner;
type-aware linting waits for the TS 7.1 programmatic API.

### The JudgeClient interface (decision D2)

One method: `judge({system, user, schema, maxTokens}) → {ok, verdict} | {ok:false, note}`.
`maxTokens` is the maximum visible structured answer, and every check sets it
to the suite-wide 32,768 of
[ACA-0070](../decisions/ACA-0070-judge-token-budgets.md). Wires differ in
whether hidden reasoning is charged against that same number; the raised bound
leaves room for both readings, and an adapter may still fork to translate the
request behind this frozen port
([ACA-0064](../decisions/ACA-0064-qwen-reasoning-budgets.md)). The bound is a
ceiling, not a reservation: providers bill only emitted tokens.
Contract every adapter must meet:

- **Structured output against a strict JSON schema** (`additionalProperties:
  false`, all fields required). A provider that cannot supply this natively is
  not an eligible adapter.
- **Refusal or schema-parse failure degrades to a `warn` verdict with a
  note — never a crash, never a silent pass.** One exception
  ([ACA-0011](../decisions/ACA-0011-gate-down-classification.md)): a
  transport error that rejects the *account* (auth/quota — 401/402/403 on
  any wire, plus each provider's named depleted-account shape) throws
  `JudgeUnavailableError` and stops the run. Per-file warns stay reserved
  for per-request degradation — transient faults included, where no
  judgment may have landed — but a dead gate must never surface as warns.
- **Prompt-prefix caching is used where the provider offers it** and silently
  skipped where it does not. Cost, not behavior, varies by provider.
- No sampling or reasoning knobs in the interface. Determinism comes from the
  strict schema, a pinned prompt version, calibration fixtures, and any
  adapter-local inference policy fixed in source — not runtime tuning. Qwen
  sends `max_tokens` and a `thinking_budget` both derived from `maxTokens`;
  neither is configurable independently.

Selection: `aca.config.json` maps a check's declared tier (T1 judgment / T2
build / T3 mechanical, the ENG-0151 vocabulary) to `{provider, model}`;
`ACA_PROVIDER` / `ACA_MODEL` env override for one-off runs. Credentials use
the provider's named environment variable; Qwen additionally requires its
explicit `QWEN_BASE_URL`. The suite never stores or logs keys.

### Change scope (decision D5)

Checks judge **changed files against the merge-base with `origin/main`** —
never the whole tree, never the diff in isolation. Scope config lives in the
consuming repo's `aca.config.json`: `include` globs (its guarded source),
`exclude` globs (generated files, vendored copies, lockfiles). Explicit paths
on the CLI bypass diff selection for local iteration.

### Verdict cache (decision D7, key extended by ACA-0013)

`.cache/aca/<check>/` (gitignored), keyed on every semantic input to the
comparative judgment:
`sha256(comparison kind ‖ base path+content+import edges (or an explicit absent-base marker) ‖ head path+content+import edges ‖ rule text ‖ prompt version ‖ token bound ‖ provider ‖ model id)`.
The token bound is in the key because on a wire that derives hidden reasoning
from it, the bound is part of the inference profile rather than a mere output
ceiling ([ACA-0070](../decisions/ACA-0070-judge-token-budgets.md)).
The import edges are in the key because the verdict depends on them (review
finding, PR #1): a new importer changes the footprint question even when the
file's content is unchanged. The base ref/SHA, diff hunks, and line counts
are deliberately *excluded* — identity-independent or derived from the
snapshots; keying on them would re-bill every file whenever the merge-base
moves and defeat the guarantee. So: the same semantic pair across runs costs
zero API calls even as the merge-base moves, while the same head against a
*different* base is rejudged — verifiably, cache hits are observable in
`--json` output. Iterating on the judge prompt invalidates the cache by
construction; that re-billing spike is accepted.

### Exit codes (decision D3)

| Code | Meaning |
| --- | --- |
| 0 | Advisory run (always), or enforce run with no `fail` verdicts |
| 1 | `--enforce` and at least one `fail` |
| 2 | Usage / config error |
| 78 | `--enforce` and the gate is down (`EX_CONFIG`): no credentials resolve, or the judge rejected the account at judge time (auth/quota, ACA-0011) — CI must treat a missing or dead judge as its own signal, never as "code is fine" |

Advisory mode with the gate down — no credentials, or auth/quota rejection
mid-run — prints one line naming the outage and exits 0; it never emits
per-file warns that read as judgments (ACA-0011).

`--self-test` shares the same table: 0 only when the check's calibration
reaches its required qualification level, 1 on any fixture/level miss (even
without `--enforce`), 2 for a missing self-test or an invalid calibration
package, 78 when the judge is unavailable (no credentials, or gate down
mid-calibration — an outage is not a fixture miss). `--json` applies to `--self-test`
and emits one qualification object from the check's structural report
(ACA-0012); the shared `SelfTestResult` contract stays `{passed, lines}`.

## Decisions

Accepted 2026-08-04 and extracted to repo-local records (numbering per
[ENG-0035](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0035-issue-derived-record-numbers.md)
with the consolidation delta recorded in the
[decisions index](../decisions/README.md); single-repo decisions live here,
not in the ENG series):

- **[ACA-0003](../decisions/ACA-0003-suite-contracts.md)** — suite contracts:
  D1 one entrypoint / loose coupling, D2 provider-agnostic JudgeClient,
  D3 advisory-default + `EX_CONFIG`, D4 token-budget output, D6 tier-registry
  model routing, D7 content-addressed verdict memoization.
- **[ACA-0004](../decisions/ACA-0004-context-footprint-judgment.md)** —
  judgment semantics: D5 file-as-it-stands with load-set accounting,
  D8 fixture-gated prompts.
- **[ACA-0011](../decisions/ACA-0011-gate-down-classification.md)** —
  gate-down classification (2026-08-05): judge auth/quota rejection throws
  and stops the run (exit 78 enforce/self-test, one-line notice advisory);
  extends D2's degrade contract and D3's exit table.
- **[ACA-0013](../decisions/ACA-0013-comparative-judgment.md)** —
  comparative judgment (2026-08-05): direction of change for legacy files,
  residual debt as structured nonblocking findings, pair-addressed cache
  key. Supersedes D5's absolute state for legacy files.
- **[ACA-0020](../decisions/ACA-0020-diff-fixture-corpus.md)** —
  diff-scoped checks (2026-08-05): before/after pair-fixture corpus, one
  canonical diff artifact (git and in-memory tree constructors), and the
  diff judge I/O convention — head-line-numbered unified payload, a
  120k-char bound all diff checks inherit, whole-file omission that always
  surfaces as `warn`, findings anchored to added head lines only.
- **[ACA-0059](../decisions/ACA-0059-npm-release-boundary.md)** — npm release
  boundary (2026-08-06): authored TypeScript remains build-free in development;
  publication emits ignored JavaScript, copies runtime assets, and exposes an
  exact privacy-reviewed tarball surface.
- **[ACA-0064](../decisions/ACA-0064-qwen-reasoning-budgets.md)** — Qwen
  reasoning budgets (2026-08-05): preserve the frozen JudgeClient, define
  `maxTokens` as visible answer capacity, and bound provider reasoning
  deterministically inside the dedicated adapter.
- **[ACA-0070](../decisions/ACA-0070-judge-token-budgets.md)** — judge token
  budgets (2026-08-10): one raised bound of 32,768 for every check and every
  route, so reasoning-capable models stop truncating on wires that charge
  hidden reasoning to the answer allowance. Narrows ACA-0064's Qwen-only
  remedy without unfreezing the port.

## Security posture (ENG-0012 priority 1)

File content is sent to the configured model provider — for private repos
that is an explicit data-egress decision the consuming repo's owner makes by
choosing the provider (the local adapter exists precisely so the check can run
with zero egress). Credentials are never read, stored, or logged by the suite;
SDK-standard env resolution only. Judge output is data, never executed;
findings render as text.
