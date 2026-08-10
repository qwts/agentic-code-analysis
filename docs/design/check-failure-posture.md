# Design: `aca failure-posture`

**Status:** Proposed — acceptance is the owner's approval of the PR that
introduces this document (issue
[#18](https://github.com/qwts/agentic-code-analysis/issues/18); plan comment
of 2026-08-05). Second check of the suite; consumes the
[suite design](suite.md) contracts and forks the proven comparison shape of
[context-footprint](check-context-footprint.md) without widening any shared
interface (ACA-0003 D1: checks never import each other).

## What it judges

Each in-scope changed file that touches **external dependencies**, against
the [file-failure-posture rubric](../standards/file-failure-posture.md): how
does this code behave when those dependencies are slow, down, or lying? The
rubric is the single authoritative, runtime-read criterion source; this
document owns execution policy only.

An external dependency is an effect boundary outside the current process's
deterministic memory: network services, durable local/remote storage,
queues/brokers, or subprocesses. Out of scope: clock/random usage, IaC diffs
(backlog `config-blast-radius`), load testing, and cross-service guarantees
such as idempotency or exactly-once (too much cross-service context for file
scope).

Comparative semantics per ACA-0013, identical to context-footprint: a **new**
file is judged absolutely; a **legacy** file on the direction of change —
pre-existing debt never blocks, worsening it does. A rename stays legacy
under its base path; a copy/extraction is new.

Tier: **T1 (judgment)**. Routing only through the consuming config's tier map
and `ACA_PROVIDER`/`ACA_MODEL` overrides — no model name in code (the
issue's `claude-opus-5` recommendation is provisional configuration).

### Boundary with `fail-posture-security` (backlog)

The boundary is scenario-level, recorded in the rubric so the judge enforces
it: this check owns availability, latency/resource exhaustion,
durability/data loss, false operational success, and stale/corrupt
operational state. Auth fail-open, privileged continuation, trust-boundary
bypass, and secret/PII exposure report exclusively to
`fail-posture-security`. There is deliberately no generic `fail-open`
criterion here, and the same concrete scenario must never appear in both
checks; a path with an independent operational consequence reports only that
operational scenario.

## Applicability: the mechanical prefilter

A pure, deterministic classifier (`prefilter.ts`) decides only whether
evidence **may** be relevant — it never produces a semantic verdict. It runs
over both snapshots after comparison preparation:

- **new** file: head only; **legacy**: base and head, so an added effect is
  judged as regression and a removed one can be judged as improvement;
- both sides confidently irrelevant → **zero `JudgeClient.judge` calls**
  (the zero-cost guarantee is zero provider requests; CLI credential
  resolution is unchanged);
- unreadable, unsupported, or ambiguous evidence → judge or warn, never a
  silent skip.

Classification by format, biased toward false positives (an extra T1 call is
cheaper than suppressing an incident-grade finding):

- **JS/TS** (the supported syntax): token scan for direct APIs (`fetch`,
  sockets, filesystem/database/queue/subprocess calls), runtime imports /
  dynamic imports / `require` of effectful modules (type-only imports are
  ignored; comment- and string-only mentions stripped where practical), and
  awaited calls on injected boundary-like symbols (`*Client`, `*Repository`,
  `*Store`, `*Queue`, `*Gateway`, `*Transport`, …). Signals found → judge;
  none → skip.
- **Known IaC formats** (`.tf`, `.tfvars`, `.hcl`) → mechanically out of
  scope (backlog `config-blast-radius`).
- **Known non-executable formats** (docs, data, markup, lockfiles, images,
  declarative config) → skip; they cannot carry a failure posture.
- **Anything else** (unknown or unsupported source languages, extensionless
  scripts) → candidate, judged from content without mechanical signals —
  never silently skipped.

Signals are typed routing hints — dependency kind
(`network | storage | queue | subprocess`), source
(`import | call | injected-boundary`), matched token — passed to the judge
**explicitly labeled as hints, not proof**.

A mechanical skip is a check-local structural subtype of the frozen
tri-state `FileVerdict`: `verdict: pass`, `skipped: true`, `cached: false`,
no violations. Text output stays findings-only (a skip prints nothing);
`--json` exposes that no semantic judgment occurred. A skip is **never
cached** — it is free to recompute and caching it would hide prefilter-rule
changes.

## Judge input, per candidate file

One `JudgeClient.judge` request per candidate, rubric-in-system /
payload-in-user:

- `system`: the complete rubric embedded verbatim from disk (never
  paraphrased), comparison instructions, the scenario-evidence requirement,
  and the security boundary — one cached prefix per run;
- `user`: kind (and base path when renamed), growth orientation line,
  prefilter hints per side (labeled as routing hints), imports and
  imported-by **paths only** per snapshot, full head content, and full base
  content for legacy files.

Merge-base resolution, rename/copy classification, and snapshot assembly are
forked from context-footprint (`comparison.ts`, `import-graph.ts`); an
invalid merge-base is a run-level configuration error (exit 2), and
unavailable per-file evidence is a non-cacheable `warn`.

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "new-compliant | new-violating | improved | held | regressed | uncertain",
  "before_failure_posture": "the practical-test answer for the base version; '(none — new file)' for new",
  "after_failure_posture": "the practical-test answer for the head version",
  "comparison_evidence": "specific before-to-after evidence for the assessment",
  "head_violations": [{
    "criterion": "missing-timeout | retry-without-backoff | unbounded-retry | swallowed-failure | unbounded-buffering | stampede-prone | unchecked-external-result",
    "evidence": "the concrete misbehavior scenario, anchored to the code",
    "suggestion": "the concrete change that would fix the posture"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

`evidence` must be the causal finding — *if this dependency is slow/down/
wrong, this code responds this way, causing this observable impact*. The
scenario is the finding; the criterion is only its label. Blank blocking
evidence degrades to a malformed, non-cacheable `warn`.

**Effective-verdict mapping (ACA-0013, host code decides):**

| Kind | Assessment | Effective verdict |
| --- | --- | --- |
| new | `new-compliant` | `pass` |
| new | `new-violating` (scenario evidence required) | `fail` |
| legacy | `improved` / `held` | `pass`; head violations retained as residual debt |
| legacy | `regressed` (scenario evidence required) | `fail` |
| either | well-formed `uncertain` | `warn`, cacheable |
| either | refusal, malformed, kind-incompatible, or evidence-free blocking assessment | `warn`, **not** cacheable |

Any new or materially worsened named scenario makes a legacy result
`regressed`; improvement elsewhere cannot offset it. The check returns a
verdict subtype (`assessment`, optional `basePath`, `residualViolations`,
optional `skipped`) — the shared registry contract is not widened.

## Operational bounds and memoization

Identical to context-footprint: one file per request, concurrency 3,
`max_tokens` 32768, inputs normalized and deduplicated before the pool,
stable input-order results. Prompt version pinned
(`failure-posture-v1`) — any prompt, rubric, payload, or applicability-rule
change that can alter judgment routing bumps it; fix the prompt or routing
rule, never the calibration fixtures.

Cache (`.cache/aca/failure-posture/`) holds judged, cacheable outcomes only.
The pair-addressed key is prompt version, comparison kind, explicit
absent-base marker or full base snapshot, full head snapshot
(path/content/imports/imported-by each), rubric text, provider, model.
Prefilter hints are deterministic from those inputs and add nothing; base
ref/SHA, growth, and line counts are excluded — the same semantic pair hits
when the merge-base moves; the same head against a different base misses.

## Calibration — the graded self-test (ACA-0004 D8, ACA-0012)

Fixtures are a purpose-built network pair (a status publisher: direct
`fetch` in an uncapped hot retry loop with no deadline vs. per-attempt
deadline + caller signal, bounded attempts, capped jittered backoff, checked
response, failure surfaced with cause):

- **`foundation`** — unsafe as new → `new-violating`/`fail` naming **all
  of** `missing-timeout`, `retry-without-backoff`, `unbounded-retry` (the
  forked manifest schema adds a `criteriaAllOf` oracle for this); resilient
  as new → `new-compliant`/`pass`; unsafe → resilient →
  `improved`/`pass`; resilient → unsafe → `regressed`/`fail` with the same
  required criteria.
- **`field`** — unchanged unsafe legacy → `held`/`pass` with the debt
  named as residual findings carrying nonblank scenario evidence. Required
  level: **`field`**.

An always-pass judge, or one that emits labels without scenario evidence,
misses calibration by construction. Close controls (one-shot calls that
surface errors, catch-and-rethrow, caller-provided cancellation, cancellable
streams, bounded reads, best-effort telemetry, single-flight cache fill)
live in unit fixtures for the prefilter and judge-io tests, not in the paid
calibration set.

## Wiring

One lazy loader entry in `src/checks/registry.ts`; fixture path excluded in
`aca.config.json`; README lists the check. No changes under `src/core/**`,
`src/cli.ts`, or `src/checks/context-footprint/**`.
