# Design: skill-information-architecture check

**Status:** Accepted for implementation by issue #52. Architecture follows
[ACA-0023](../decisions/ACA-0023-agent-context-check-architecture.md) and
consumes only the public [instruction-corpus](instruction-corpus.md) facade.

## Purpose and boundary

`aca skill-information-architecture [paths…]` judges whether one Agent Skill
delivers cohesive, valuable instructions at the right load stage. It is a T1
check over a whole physical repository skill package: discovery metadata, the
ordered activated `SKILL.md` body, and its on-demand resources. It judges
placement and routing, not prose density, command correctness, generic
Markdown style, or trigger quality.

The closed rubric is:

- `buried-core-guidance` → `move-earlier`;
- `fragmented-core-workflow` → `co-locate` or `inline-core`;
- `eager-specialist-detail` → `extract-resource`;
- `weak-disclosure-route` → `add-route`.

Length and file count never fail by themselves. A long cohesive specialist
workflow and a concise rare-but-high-consequence safeguard are protected.
Cross-load-unit duplication is not a fifth criterion; it is a follow-up.
Placement changes run before `agent-context-cost` density changes, and both
checks must be rerun before applying another exact-span proposal.

## Selection and public evidence mapping

The selectable universe is exactly repository packages bound by the corpus.
A package root is an `InstructionFile` named `SKILL.md` with a `skill-body`
binding. Descendant files with `skill-resource` bindings are members. The same
physical package is judged once while retaining every host/profile binding.

The activated body and metadata costs come from their charged projections,
never `SKILL.md.fullFile`. An available textual resource exposes `fullFile` as
a potential-read estimate only; it is charged only when declared or observed
task evidence says it was read. Availability joins `corpus.diagnostics` by
locator, so an unreadable, oversized, or escaping resource cannot masquerade
as an empty one. A pinned extension plus NUL/replacement/control-character
classifier marks opaque resources; their paths and routes remain visible but
no token claim is made.

A target package directory, its `SKILL.md`, any descendant resource, or the
check sidecar selects the whole package. A directory selects bound packages
beneath it. `FileVerdict.file` is the repository-relative root `SKILL.md`;
rich output also carries stable `packageId` (`repo:<packageDir>`) and
`packageDir`. An explicitly targeted, unbound `SKILL.md` produces a mechanical
warning rather than being guessed into the package universe.

## Task evidence

The suite convention for check-local evidence is `.aca/<check>.json`, with a
required schema version and `ConfigError` for malformed or escaping data. This
check reads `.aca/skill-information-architecture.json`, keyed by stable package
id. Scenarios normalize an id, description, profile, optional frequency or
value weight, criticality, required concepts, expected resources, and observed
reads. Resource evidence normalizes portable separators and heading fragments,
then must resolve to a package member. Missing evidence yields
`basis: cohesion-only`; frequency-dependent
placement claims must then be `uncertain`, never guessed. Normalized evidence
and its schema version are semantic cache inputs.

## Mechanical topology

The host derives ordered, fence-aware body sections; per-profile metadata/body
activation; resource availability and potential tokens; and disclosure routes.
Routes include Markdown inline/reference links and exact plain or backticked
relative resource paths. A source-verified package-root variable may resolve;
other variable-prefixed paths are `target-unverifiable`, not fabricated broken
links. Permission-only frontmatter references are not disclosure routes.

Route status is `resolved`, `missing`, `external`, `escapes-package`,
`fragment`, or `target-unverifiable`. Missing/escaping targets, cycles,
unavailable resources, and opaque resources keep the topology incomplete and
cannot support a clean pass. Unlinked present resources remain evidence for
`weak-disclosure-route`.

## Judge contract and bounds

One package is sent per request, concurrency 3, `maxTokens: 32768`. The input is
bounded at 120,000 characters. Files are included whole in deterministic path
order; nothing is silently truncated. Omitted resources appear in an omission
manifest. If the root body alone exceeds the bound, the package warns without
a judge call.

The prompt treats package text as quoted data and asks only for assessment
(`well-structured | needs-restructure | uncertain`), closed-rubric findings,
exact source/heading/excerpt evidence, affected scenario ids, one allowed
action, destination, proposed route/outline text, preservation spans, and a
short rationale. It never asks the model to count tokens, calculate
percentages, infer workload frequency, or invent paths.

Host verification proves source/scenario/destination existence, unique exact
spans, action/destination compatibility, package containment, non-overlap,
preservation spans, and route validity. The host alone derives impact order,
scenario weights, before/after activated-body and conditional token estimates,
resource-open deltas, a proposed topology, bounded `add | delete | replace`
edits, and `measurementSeed`.

Verdict policy:

- complete `well-structured` with no findings → cacheable pass;
- `needs-restructure` with a verified, patchable finding → cacheable fail;
- `uncertain` with no findings → cacheable warn;
- incomplete evidence, unsupported frequency claims, contradictory output,
  invalid spans/actions/routes, or unverifiable proposals → non-cacheable warn.

Only the validated semantic result is cached. The key includes prompt/schema/
verifier versions, canonical topology and omission manifest, diagnostics,
normalized task evidence, estimator, input-char and judge-token bound
identities, provider, and
configured model—not CLI spelling, base identity, or unrelated files.

## Calibration and measurement handoff

The live, uncached, checksummed fixture exam has cumulative levels:

1. `foundation`: well-structured Git package passes; the monolithic inverse
   fails buried/eager placement.
2. `coverage`: fragmented checkout/pull, weak rebase routing, and a same-token
   good/bad ordering control.
3. `boundaries` (required): long cohesive specialist passes, a concise rare
   recovery safeguard stays eager, and absent frequency evidence yields
   uncertain/warn.

Preflight validates the manifest, complete package trees, sidecars, checksums,
levels, and same-token invariant before spend. Lower-level failure skips later
calls. Prompt changes bump the pinned version; fix the prompt, never fixtures.

Rich JSON is a harness-neutral SkillOpt-style handoff: current/proposed
topology, verified edits, measurement seeds, and score-ready scenario ids.
Static grader evaluation reports macro-F1 by rubric, evidence-span accuracy,
action validity, and unknown-frequency abstention recall. A sibling evaluation
may execute frozen target-agent A/B runs and read telemetry; that research
harness is not required to make this check usable. Correctness gates any
efficiency claim: held-out task success must not regress.
