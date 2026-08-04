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
`sha256(file content ‖ sorted import paths ‖ sorted imported-by paths ‖ rule text ‖ prompt version ‖ provider ‖ model id)`.
The import edges are in the key because the verdict depends on them (review
finding, PR #1): a new importer changes the footprint question even when the
file's content is unchanged. Diff hunks and the growth line are deliberately
*excluded* — they are orientation, not semantic state, and they change
whenever the merge-base moves; keying on them would re-bill every file on
every push and defeat the guarantee. So: semantically unchanged files across
runs cost zero API calls — verifiably, cache hits are observable in `--json`
output. Iterating on the judge prompt invalidates the cache by construction;
that re-billing spike is accepted.

### Exit codes (decision D3)

| Code | Meaning |
| --- | --- |
| 0 | Advisory run (always), or enforce run with no `fail` verdicts |
| 1 | `--enforce` and at least one `fail` |
| 2 | Usage / config error |
| 78 | `--enforce` and no credentials resolve (`EX_CONFIG`) — CI must treat missing-secret as its own signal, never as "code is fine" |

Advisory mode with no credentials prints one line and exits 0.

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

## Security posture (ENG-0012 priority 1)

File content is sent to the configured model provider — for private repos
that is an explicit data-egress decision the consuming repo's owner makes by
choosing the provider (the local adapter exists precisely so the check can run
with zero egress). Credentials are never read, stored, or logged by the suite;
SDK-standard env resolution only. Judge output is data, never executed;
findings render as text.
