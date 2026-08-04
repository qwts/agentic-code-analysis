# Design: the agentic-code-analysis suite

**Status:** Proposed — presented for review before any implementation.
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
   interface, never to a vendor SDK. Adapters: Anthropic, OpenAI, local
   (OpenAI-compatible endpoint, e.g. LM Studio / Ollama). Provider and model
   are configuration.

## Architecture

```
aca <check> [--enforce] [--json] [--base <ref>] [--self-test] [paths…]

src/
  cli.mjs                 dispatcher: parse args, route to a check, map exit code
  core/
    change-scope.mjs      changed files vs merge-base(origin/main), include/exclude globs
    judge-client/         the JudgeClient interface + one adapter per provider
    verdict-cache.mjs     content-addressed memoization of judge verdicts
  checks/
    context-footprint/    first check — prompt, schema, verdict mapping, fixtures
```

### The JudgeClient interface (decision D2)

One method: `judge({system, user, schema, maxTokens}) → {ok, verdict} | {ok:false, note}`.
Contract every adapter must meet:

- **Structured output against a strict JSON schema** (`additionalProperties:
  false`, all fields required). All three target providers support this
  natively; a provider that cannot is not an eligible adapter.
- **Refusal or schema-parse failure degrades to a `warn` verdict with a
  note — never a crash, never a silent pass.**
- **Prompt-prefix caching is used where the provider offers it** and silently
  skipped where it does not. Cost, not behavior, varies by provider.
- No sampling knobs in the interface. Determinism comes from the strict
  schema, a pinned prompt version, and calibration fixtures — not temperature.

Selection: `aca.config.json` maps a check's declared tier (T1 judgment / T2
build / T3 mechanical, the ENG-0151 vocabulary) to `{provider, model}`;
`ACA_PROVIDER` / `ACA_MODEL` env override for one-off runs. Credentials use
each provider SDK's standard env resolution — the suite never handles keys.

### Change scope (decision D5)

Checks judge **changed files against the merge-base with `origin/main`** —
never the whole tree, never the diff in isolation. Scope config lives in the
consuming repo's `aca.config.json`: `include` globs (its guarded source),
`exclude` globs (generated files, vendored copies, lockfiles). Explicit paths
on the CLI bypass diff selection for local iteration.

### Verdict cache (decision D7)

`.cache/aca/<check>/` (gitignored), keyed
`sha256(file content ‖ rule text ‖ prompt version ‖ provider ‖ model id)`.
Unchanged files across runs cost zero API calls — verifiably: a cache hit is
observable in `--json` output. Iterating on the judge prompt invalidates the
cache by construction; that re-billing spike is accepted.

### Exit codes (decision D3)

| Code | Meaning |
| --- | --- |
| 0 | Advisory run (always), or enforce run with no `fail` verdicts |
| 1 | `--enforce` and at least one `fail` |
| 2 | Usage / config error |
| 78 | `--enforce` and no credentials resolve (`EX_CONFIG`) — CI must treat missing-secret as its own signal, never as "code is fine" |

Advisory mode with no credentials prints one line and exits 0.

## Decisions

Recorded inline while Proposed; on acceptance each hardens into a repo-local
`ACA-NNNN` record named after its originating issue number (the
[ENG-0035](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0035-issue-derived-record-numbers.md)
convention; this repo's decisions are single-repo, so they live here, not in
the ENG series).

**D1 — one entrypoint, loosely coupled checks.** `aca <check>` subcommands in
one npm package; checks share only the three core libraries. *Why:* the
commonly-trained CLI shape, and one install for consumers. *Downside:* the
core libraries are a real coupling point and a change to one touches every
check; mitigated by keeping their interfaces narrow and frozen — a check
needing more forks the library rather than widening it.

**D2 — provider-agnostic JudgeClient.** As specified above. *Why:*
declaration; also survivability — model churn is the steady state (ENG-0151).
*Downside:* lowest-common-denominator features; prompt caching and pricing
differ per provider, so cost characteristics are not portable even though
behavior is. Calibration fixtures must pass per provider, and a provider that
cannot pass them is documented as unsupported for that check rather than
quietly worse.

**D3 — advisory by default, `--enforce` opt-in, `EX_CONFIG` for missing
credentials.** *Why:* an agent mid-loop needs signal, not a blocked build; CI
promotion is an owner decision per consuming repo. *Downside:* advisory
findings can be ignored forever. Accepted; the promotion path exists and the
data to justify it accumulates in advisory runs.

**D4 — output is a token budget, not a report.** Compact findings-only text by
default; `--json` is the stable machine contract (schema versioned with the
suite). *Why:* ENG-0012 — agents are the primary readers; token efficiency is
economic policy. *Downside:* terse for humans; per ENG-0012 humans read the
agent-optimized form, and the `--json` output is what a richer surface would
build on.

**D5 — judge the file as it stands, selected by the change.** The diff decides
*which* files are judged; the verdict is about the file's current state, with
statically derived context (import edges, growth) so the judge reasons rather
than guesses. *Why:* the rule is a property of files, not of diffs; judging
diff quality invites relitigating history. *Downside:* a PR can be failed for
debt it merely touched, not created. Accepted deliberately — that is how
ratchets already work here, and `warn` exists for the boundary.

**D6 — model choice follows the tier registry pattern.** Checks declare a
tier; config maps tier → provider/model; nothing hardcodes a model name.
*Why:* ENG-0151 — recalled model names fail confidently. *Downside:*
indirection for a suite with one check; accepted because the second check is
the plan, not a hypothesis.

**D7 — content-addressed verdict memoization.** As specified above. *Why:*
unchanged files must never re-bill; cache correctness is provable from the
key. *Downside:* no cross-machine sharing in v1 (each CI runner pays once per
content) — a shared cache backend is a later, separate tool if the spend data
says so.

## Security posture (ENG-0012 priority 1)

File content is sent to the configured model provider — for private repos
that is an explicit data-egress decision the consuming repo's owner makes by
choosing the provider (the local adapter exists precisely so the check can run
with zero egress). Credentials are never read, stored, or logged by the suite;
SDK-standard env resolution only. Judge output is data, never executed;
findings render as text.
