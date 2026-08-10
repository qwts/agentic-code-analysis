# Design: `aca seam-audit`

**Status:** Accepted with the implementation PR (single PR per owner
instruction, 2026-08-05 — the issue plan's design-only-PR-first sequencing is
collapsed; design acceptance folds into PR approval). Origin:
[#17](https://github.com/qwts/agentic-code-analysis/issues/17). Consumes the
[suite design](suite.md) contracts (JudgeClient, change scope, verdict cache,
exit codes) and adds only what is specific to this check.

## What it judges

Each changed file's **testability footprint**: which of its dependencies have
no seam, and what would a focused test of its core logic have to patch? A
seam is a place where a test can substitute a dependency's behavior without
editing the file, patching a global, or intercepting module loading — an
explicit parameter, constructor dependency, port, or caller-supplied factory.
A **missing seam** is a dependency at a natural variability boundary
(external I/O or service, clock, randomness, environment, mutable ambient
state) reachable only by patching a global/module/loader or exercising the
real dependency.

Dependencies are never failures by themselves: a file whose collaborators
arrive through seams passes however many it has. Deterministic local/value
construction, an intentional composition root, and a thin boundary adapter
(one that binds an ambient capability behind a port and contains no domain
policy) are not failures; import-time startup work is. The authoritative
rubric is a runtime-read asset, [`src/checks/seam-audit/rubric.md`](../../src/checks/seam-audit/rubric.md)
— check-local rather than `docs/standards/` because that directory holds
vendored external standards with a canonical source, and this rubric has
none. Its exact text is part of the cache key.

**Comparative semantics per ACA-0013**, mirroring context-footprint: a
**new** file (absent at the merge-base) is judged absolutely; a **legacy**
file is judged on direction. Pre-existing missing seams are residual debt,
never a new gate failure; only an introduced or materially worsened missing
seam blocks. A rename stays legacy under its base path; a copy/extraction is
new. Unresolvable merge-base is a run-level ConfigError; unreadable per-file
evidence is a non-cacheable warn, never an inferred new file.

Out of scope: seam *placement* quality and over-seaming (backlog:
`seam-placement`); mock-depth analysis of tests (backlog: `mock-depth`);
generated code. Tier: **T1 (judgment)**; routing from the consuming config's
tier map, never code.

## Standalone v1 and the shared-evidence note

V1 forks only the evidence assembly it needs. It does not import
`src/checks/context-footprint/*`, move that check's helpers into core, or
change JudgeClient, adapters, change-scope, or VerdictCache; its only
existing-source integration is the lazy registry entry.

Recorded for the future, not built: this check reads the same
what-does-this-file-reach-for evidence as context-footprint. A shared
evidence pass would extract **rename-aware base/head snapshots** — normalized
path, content, import edges, reach-for candidates, and read errors — and
nothing else; each check would still own its rubric, prompt, verdict mapping,
cache, and provider use. Promoting that into a shared core library requires
the check-group decision on the agent-context epic; this check must not
silently create it.

## Mechanical prefilter: a proof, not a smell blacklist

Pure-leaf files are trivially `pass` without a judge call — but "no imports"
is not proof: an import-free file can still call `Date.now()`,
`Math.random()`, `fetch()`, read `process.env`, `new` up a client, or do work
at module evaluation.

V1 uses a narrow tokenizer + allow-list recognizer for **declarative JS/TS
leaf forms only**: comments, `const` declarations initialized to literals
(with type annotations), type aliases, interfaces, local export lists, and a
literal default export. A file is mechanically passed only when the
recognizer proves there is no runtime dependency acquisition, no ambient
access, no call/new expression, and no executable module initializer.
Anything else — any import/require, function declaration (body analysis is
judgment), enum, template interpolation, call-like syntax, or unknown
syntax — goes to the judge. False negatives cost one call; a false positive
silently hides debt, so every ambiguity resolves to "unproven". No runtime
AST dependency is added for this optimization.

Comparative handling:

- new + head proven leaf → mechanical `new-compliant`/`pass`;
- legacy + base and head both proven leaf → mechanical `held`/`pass`;
- every other case → cache/judge path.

A mechanical pass is recomputed rather than cached and carries
`source: "mechanical-prefilter"`, `cached: false`, and an empty testability
footprint in `--json` — the zero-call path is observable without widening
FileVerdict or changing the CLI. The guarantee is zero judge *requests*, not
credential-free execution: the dispatcher resolves the client before
`Check.run`, and this check does not alter that contract.

## Judge input, per file

The system prompt embeds the rubric verbatim (one cached prefix per run).
The user payload is one comparison: kind (and base path when renamed), per
snapshot the **outbound dependencies** (static imports, re-exports,
side-effect imports, dynamic imports, lexically resolvable CommonJS
`require`; sorted, deduplicated, relative specifiers repo-resolved) and
**conservative ambient-access candidates** (mechanical hints — clock,
randomness, env, network, timers, constructor calls; never exhaustive,
never a verdict), then the full head content — and for legacy, the full base
content. Summaries orient the judge; the source stays authoritative.

## Judge output

Strict schema (`additionalProperties: false`, all fields required):

```json
{
  "assessment": "new-compliant | new-violating | improved | held | regressed | uncertain",
  "comparison_evidence": "specific before-to-after evidence; '(none — new file)' for new",
  "dependencies_without_seams": [{
    "dependency": "stable name such as Date.now or globalThis.fetch",
    "criterion": "hardwired-dependency | ambient-state | ambient-io | import-time-side-effect",
    "change": "new | introduced | worsened | pre-existing",
    "access_point": "the specific function or module-level expression",
    "evidence": "quotable source observation",
    "test_patch": "the global/module/loader target a focused test would have to patch",
    "suggested_seam": "the natural parameter, port, or factory"
  }],
  "reasoning_summary": "2-3 sentences max"
}
```

Deviation from the issue plan: the per-item `change` value `uncertain` is
dropped. Assessment-level `uncertain` already covers ambiguity, and a
per-item "uncertain" has no coherent blocking-vs-residual mapping — it could
only ever produce degradations.

Criteria (non-overlapping; the only valid labels):

- **hardwired-dependency** — core logic chooses/constructs a concrete
  collaborator or reaches through an imported singleton instead of accepting
  a replacement;
- **ambient-state** — core logic directly reads clock, randomness,
  environment, or mutable process/global state;
- **ambient-io** — core logic directly performs network, filesystem,
  storage, subprocess, DOM, or similar external operations;
- **import-time-side-effect** — module evaluation performs external work or
  captures/mutates ambient state. Takes precedence for the same access so
  one dependency is not double-reported.

**Effective-verdict mapping** — host code decides, the model describes:

| Kind | Assessment | Item constraint | Effective verdict |
| --- | --- | --- | --- |
| new | `new-compliant` | empty footprint | `pass` |
| new | `new-violating` | ≥ 1 item, all `change: "new"` | `fail` |
| legacy | `improved` / `held` | only `pre-existing` items | `pass`; items retained as **residual debt** |
| legacy | `regressed` | ≥ 1 `introduced`/`worsened` (blocking); `pre-existing` stay residual | `fail` |
| either | `uncertain` | — | `warn`, cacheable (describes the pair) |
| either | refusal, transport/schema failure, kind/change mismatch, blank blocking evidence | — | `warn`, **not** cacheable |

The check's verdict subtype (`SeamAuditVerdict`, structural — FileVerdict is
not widened) preserves `assessment`, optional `basePath`, the full structured
`testabilityFootprint`, `source`, and `residualViolations` in `--json`, and
derives the shared Violation fields for the compact text renderer — evidence
names the dependency, access point, and exact test-patch target; the
suggestion is the natural seam.

## Operational bounds and cache

One file per request; concurrency 3; `max_tokens` 32768; inputs normalized
and deduplicated; stable output order. Pair-addressed cache key: prompt
version, comparison kind, explicit absent-base marker or base
path/content/evidence, head path/content/evidence, rubric text, provider,
model. Never keyed on base ref/SHA or derivable orientation — the same
semantic pair stays a hit when the merge-base moves; changing either
snapshot, the evidence extraction's output, the rubric, prompt version,
provider, or model misses. Mechanical leaf passes bypass the cache entirely.

## Calibration — graded self-test (ACA-0012)

One fixture pair (non-code `.txt` so fixture source is not typechecked and
is excluded from scope): `hardwired-clock-network.txt` (core logic calls the
clock and network directly) and `injected-ports.txt` (the same behavior
behind injected clock/HTTP/sleep/jitter ports). Deviation from the issue
plan's flat assert list: the five cases are graded per ACA-0012 —

- **`foundation`** (endpoints): hardwired as new → `new-violating`/`fail`
  naming `Date.now` (ambient-state) and `fetch` (ambient-io) with their
  patch targets; injected as new → `new-compliant`/`pass`;
- **`field`** (transitions): hardwired → injected → `improved`/`pass` with
  an empty footprint; injected → hardwired → `regressed`/`fail` with
  introduced clock/network seams; hardwired → hardwired → `held`/`pass`
  with the missing seams retained as residual debt.

Required level: **`field`**. Always live, never cached. Expectations assert
assessment, effective verdict, structured footprint items (dependency name
substring + criterion, with nonblank evidence and test-patch), and residual
placement. A miss means fix the prompt, never the fixtures; every prompt
edit bumps the pinned version (`seam-audit-v1`) before recalibration.
