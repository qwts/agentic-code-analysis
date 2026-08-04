# ACA-0003: Suite contracts — CLI shape, JudgeClient, exit codes, output, model routing, verdict cache

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** #3 (embodying issue; the why and review trail live in the design
review, [PR #1](https://github.com/qwts/agentic-code-analysis/pull/1) / #2)

## Context

Decisions D1–D4, D6, D7 of the accepted [suite design](../design/suite.md),
consolidated into the record whose issue builds them. Reviewed against
ENG-0012 (security → compliance → agentic development → human developers).

## Decision

**D1 — one entrypoint, loosely coupled checks.** `aca <check>` subcommands in
one npm package; checks share only three narrow core libraries (change scope,
JudgeClient, verdict cache) and never import each other. *Why:* the
commonly-trained CLI shape, one install for consumers. *Downside:* the core
libraries are a real coupling point and a change to one touches every check;
mitigated by keeping their interfaces narrow and frozen — a check needing
more forks the library rather than widening it.

**D2 — provider-agnostic JudgeClient.** One method:
`judge({system, user, schema, maxTokens})`. Adapters (Anthropic, OpenAI,
local OpenAI-compatible) must provide strict-schema structured output,
degrade refusal/parse failure to `warn` (never crash, never silent pass), use
prompt-prefix caching where offered, and expose no sampling knobs. *Why:*
model interchangeability is a declaration, and model churn is the steady
state (ENG-0151). *Downside:* lowest-common-denominator features; cost
characteristics are not portable across providers even though behavior is.
Calibration fixtures must pass per provider; a provider that cannot is
documented as unsupported rather than shipped quietly worse.

**D3 — advisory by default, `--enforce` opt-in, distinct code for
"cannot judge".** Exit 0 advisory or enforce-pass; 1 enforce-fail; 2
usage/config error; 78 (`EX_CONFIG`) enforce with no credentials — CI must
treat missing-secret as its own signal, never as "code is fine". *Why:* an
agent mid-loop needs signal, not a blocked build; CI promotion is an owner
decision per consuming repo. *Downside:* advisory findings can be ignored
forever. Accepted; the promotion path exists and its justifying data
accumulates in advisory runs.

**D4 — output is a token budget, not a report.** Compact findings-only text
by default; `--json` is the stable machine contract, schema versioned with
the suite. *Why:* ENG-0012 — agents are the primary readers; token efficiency
is economic policy. *Downside:* terse for humans; humans read the
agent-optimized form, and richer surfaces (e.g. a SARIF formatter) build on
`--json`.

**D6 — model choice follows the tier registry pattern.** Checks declare a
tier (T1/T2/T3); `aca.config.json` maps tier → provider/model; nothing
hardcodes a model name. *Why:* ENG-0151 — recalled model names fail
confidently. *Downside:* indirection for a suite with one check; accepted
because the second check is the plan, not a hypothesis.

**D7 — content-addressed verdict memoization.**
`.cache/aca/<check>/` keyed
`sha256(file content ‖ sorted import paths ‖ sorted imported-by paths ‖ rule text ‖ prompt version ‖ provider ‖ model id)`;
cache hits observable in `--json`. Import edges are in the key because the
verdict depends on them — a new importer changes the footprint question with
the content unchanged (Codex review finding on PR #1). Diff hunks and the
growth line are deliberately excluded: they are orientation, not semantic
state, and they change whenever the merge-base moves — keying on them would
re-bill every file on every push. *Why:* semantically unchanged files must
never re-bill; the key makes every verdict reproducible and attributable.
*Downside:* a cached verdict may have been produced with different hunk
context than the current run; accepted because the verdict is defined as a
property of the file and its import graph, not of the diff (D5). Also: no
cross-machine sharing in v1 — each CI runner pays once per content; a shared
cache backend is a later, separate tool if spend data says so. Prompt
iteration invalidates the cache by construction; that re-billing spike is
accepted.

## Consequences

The interface freeze is load-bearing: issue #5 (second and third adapters)
must land with zero changes under `checks/`, and a diff that violates that is
the signal D1/D2 failed, not a formality. The exit-code table is a public
contract from the first release; changing it later is a breaking change.
