# Agent context: agentic-code-analysis

A suite of small, loosely coupled CLI checks (`aca <check>`) that use an LLM
judge for structure/maintainability judgments mechanical linters cannot make.
Checks: `context-footprint`, `failure-posture`, `test-honesty`, `doc-drift`.
<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/playbook-engineering/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering) — its
[shared SOPs](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

Designs are accepted — read them before changing anything:

- [docs/design/suite.md](docs/design/suite.md) — architecture, CLI shape, exit codes (0/1/2/78), JudgeClient contract
- [docs/design/check-context-footprint.md](docs/design/check-context-footprint.md) — judge I/O, verdict semantics, calibration
- [docs/design/check-failure-posture.md](docs/design/check-failure-posture.md) — behavior when dependencies misbehave
- [docs/design/check-test-honesty.md](docs/design/check-test-honesty.md) — test-file scope, evidence bounds, honesty rubric
- [docs/design/check-doc-drift.md](docs/design/check-doc-drift.md) — doc claims vs changed referents, truth rubric, graded calibration
- [docs/design/instruction-corpus.md](docs/design/instruction-corpus.md) — shared instruction-corpus evidence library (no judging)
- [docs/design/check-agent-context-cost.md](docs/design/check-agent-context-cost.md) — value per token of instruction files, host-verified savings
- [docs/design/check-skill-information-architecture.md](docs/design/check-skill-information-architecture.md) — whole-skill ordering, cohesion, and progressive disclosure
- [docs/design/check-agent-rule-conflict.md](docs/design/check-agent-rule-conflict.md) — instruction contradictions, load-set attribution, partitioned whole-corpus judgment
- [docs/decisions/](docs/decisions/README.md) — ACA records; supersede, never rewrite
- [docs/plan/issues.md](docs/plan/issues.md) — implementation order (#3 → #4 → #5/#6)

## Standing constraints

1. **Self-application.** Every source file must satisfy
   [docs/standards/file-context-footprint.md](docs/standards/file-context-footprint.md)
   — one coherent concept, minimal context footprint. Do not split files to
   satisfy a number; answer the standard's practical test.
2. **Interfaces are frozen as designed.** Checks talk to JudgeClient, never a
   vendor SDK; checks never import each other; the three core libraries stay
   narrow — fork rather than widen.
   Language: TypeScript 7 on Node ≥ 24, erasable syntax only, `.ts` import
   specifiers, run via native type stripping during development. Per
   [ACA-0059](docs/decisions/ACA-0059-npm-release-boundary.md), npm packaging
   may emit an ignored `dist/` tree; generated JavaScript is never committed.
   `npm run typecheck` (tsgo) and `npm test` (Node's runner) must pass.
3. **No recalled model names.** Model/provider selection follows the tier map
   (ENG-0151); cite the registry or say unknown.
4. **Judge prompts are gated by the calibration self-test.** Fix the prompt,
   never the fixtures; bump the pinned prompt version on any prompt change.
5. **Workflow:** issue-first; branch from `main`; commit under the bot
   identity and sign via the Git Data API (signed-commit skill); PRs need one
   approving human review. Token-efficient output and docs — findings, not
   ceremony.
