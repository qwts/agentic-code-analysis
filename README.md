# agentic-code-analysis

Semantic, agent-powered checks for code structure and maintainability. ACA is
a suite of small, loosely coupled CLI analyses (`aca <check>`) for judgments
mechanical linters cannot make reliably: whether a change is coherent, a test
is honest, documentation is still true, or agent instructions spend their
context budget well.

Every built-in analysis is T1 (model judgment), uses the same provider-neutral
`JudgeClient`, supports advisory and CI-enforced modes, and ships a graded
calibration self-test. TypeScript runs directly on Node >= 24; there is no
development build step. The npm publication boundary emits JavaScript into an
ignored `dist/` directory because Node does not strip TypeScript beneath
`node_modules`.

## Quick start

Install ACA as a development dependency, then run its linked executable:

```bash
npm install --save-dev agentic-code-analysis
npx aca --help
```

The first registry publication is tracked in issue #66. Before that release,
clone this repository, run `npm clean-install`, and replace `npx aca` below
with `node /path/to/agentic-code-analysis/src/cli.ts`.

In the repository being analyzed, create `aca.config.json` with the files that
may select work and a provider/model route for T1. Obtain the model id from the
provider or local server you actually use; ACA does not choose one implicitly.

```json
{
  "include": ["src/**", "tests/**"],
  "exclude": ["src/generated/**", "**/*.lock"],
  "tiers": {
    "T1": { "provider": "anthropic", "model": "<model id>" }
  }
}
```

Supported routes:

| Provider | Setup |
| --- | --- |
| `anthropic` | Export `ANTHROPIC_API_KEY`. |
| `openai` | Export `OPENAI_API_KEY`. |
| `qwen` | Export `QWEN_API_KEY` and the matching `QWEN_BASE_URL`; its dedicated adapter separates the visible answer from bounded reasoning. |
| `local` | Start an OpenAI-compatible server; set `ACA_LOCAL_BASE_URL` if it is not at `http://localhost:1234/v1`. No credential is required. |

For Qwen, `maxTokens` remains the check-owned visible-answer allowance. The
adapter sends the same numeric bound separately as Qwen's `thinking_budget`;
there is no reasoning-effort environment override. This follows Qwen's
[OpenAI-compatible token semantics](https://docs.qwencloud.com/api-reference/chat/openai-chat)
but does not qualify a model: the measured `qwen3.8-max-preview` route reached
only `foundation` where `skill-information-architecture` requires
`boundaries`.

`ACA_PROVIDER` and `ACA_MODEL` together override the configured tier route for
a one-off run. Before trusting any route, qualify that exact provider/model and
check; self-tests are live and intentionally bypass the verdict cache:

```bash
npx aca context-footprint --self-test --json
```

Then run an advisory analysis from the repository being analyzed:

```bash
# Changed files against origin/main
npx aca context-footprint --base origin/main

# Explicit paths bypass change selection
npx aca context-footprint src/messages.ts --json
```

Advisory mode always exits 0, even when it reports findings. Add `--enforce`
only after observing the check and qualifying its configured route.

## CLI contract

```text
aca <check> [paths...] [--enforce] [--json] [--base <ref>] [--self-test]
aca --version
```

| Option | Behavior |
| --- | --- |
| `paths...` | Analyze explicit paths instead of selecting changed files. Check-specific selection still applies. |
| `--base <ref>` | Compare against the merge-base of this ref; defaults to `origin/main`. |
| `--json` | Emit machine-readable verdict or qualification output. |
| `--self-test` | Run the selected check's live, graded calibration exam. |
| `--enforce` | Exit 1 when any verdict fails; without it, findings are advisory. |
| `--version` | Print the installed package version. |

Exit codes are `0` for advisory/success, `1` for an enforced finding or
self-test miss, `2` for usage/configuration errors, and `78` when an enforced
run or self-test cannot reach its judge. In advisory mode a missing or dead
judge is named once and still exits 0; it never masquerades as a semantic
verdict.

## Analysis catalog

Choose the smallest analysis that answers your question. Detailed rubrics,
evidence bounds, and calibration contracts live in the linked designs.

<!-- aca-check-catalog:start -->

| Analysis | Tier | Unit | Question | Notable selection or evidence |
| --- | --- | --- | --- | --- |
| [`aca agent-context-cost`](docs/design/check-agent-context-cost.md) | T1 | One physical instruction source in selected session load sets | Does every always/conditionally loaded instruction earn its context cost? | Agent instruction corpus is discovered mechanically; target paths select session load sets. |
| [`aca agent-rule-conflict`](docs/design/check-agent-rule-conflict.md) | T1 | The complete current instruction corpus, partitioned only when bounded | Can incompatible rules co-load in a real agent session? | Any non-empty target triggers whole-corpus analysis; load-set attribution comes from the instruction corpus. |
| [`aca commit-coherence`](docs/design/check-commit-coherence.md) | T1 | One whole diff, including deletions | Is this one logical change that can be reviewed, shipped, and reverted together? | Requires merge-base history; explicit paths scope the artifact but deletions remain visible. |
| [`aca context-footprint`](docs/design/check-context-footprint.md) | T1 | Each changed source file, base versus head | What is the smallest file set needed to work on this concept safely? | New files are absolute; legacy files fail only on regression. Requires merge-base history. |
| [`aca doc-drift`](docs/design/check-doc-drift.md) | T1 | One tracked document plus its changed, explicitly referenced code | Do the document's current-truth claims still match its referents? | Defaults to `README.md` and `docs/**/*.md`; override with `checks.doc-drift.include` / `exclude`. |
| [`aca failure-posture`](docs/design/check-failure-posture.md) | T1 | Each changed file that touches an external effect boundary | What happens when a dependency is slow, down, or lying? | A mechanical effect prefilter avoids judging confident pure leaves; legacy comparisons need the base. |
| [`aca naming-truth`](docs/design/check-naming-truth.md) | T1 | Each changed file's implemented runtime exports | Do module and exported names tell the truth about behavior and side effects? | Type-only declarations, private names, locals, and pure re-exports are excluded; legacy comparisons need the base. |
| [`aca review-readiness`](docs/design/check-review-readiness.md) | T1 | One whole diff | Is the change swept of unintentional debug code, disabled tests, unlinked TODOs, and similar review debt? | Findings must anchor to added lines; requires merge-base history. |
| [`aca seam-audit`](docs/design/check-seam-audit.md) | T1 | Each changed source file's dependency footprint | Can focused tests substitute variable dependencies without patching globals or module loading? | Pure leaves may pass mechanically without judge spend; legacy comparisons need the base. |
| [`aca single-responsibility`](docs/design/check-single-responsibility.md) | T1 | Each changed source file, base versus head | Does the file have one actor and one reason to change? | Distinct from context footprint: it judges change pressure, not reading cost. |
| [`aca skill-information-architecture`](docs/design/check-skill-information-architecture.md) | T1 | One corpus-bound Agent Skill package: metadata, body, routes, and resources | Is valuable guidance cohesive and placed at the right load stage? | Optional `.aca/skill-information-architecture.json` grounds task frequency, value, criticality, and resource reads. |
| [`aca test-honesty`](docs/design/check-test-honesty.md) | T1 | Each selected test file and the exports it exercises | Would a plausible production break make each test fail for the right reason? | Test globs have safe defaults; replace them with `checks.test-honesty.testFiles`. |

<!-- aca-check-catalog:end -->

With no positional paths, most checks start from the changed-file scope. The
catalog calls out checks whose unit deliberately widens to a whole diff,
instruction corpus, document/referent bundle, or skill package. `--help`
prints the commands registered by the installed checkout.

## CI

A consuming workflow needs full history, Node 24, ACA in the consuming
project's lockfile, and the provider credential. This is an advisory job; add
`--enforce` only through an explicit promotion decision.

```yaml
steps:
  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
    with:
      fetch-depth: 0
  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
    with:
      node-version: 24
      cache: npm
  - run: npm clean-install
  - run: npx aca context-footprint --base origin/main
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

See [Adopting ACA in your repo](docs/adoption.md) for check-specific config,
cache persistence, cost posture, qualification evidence, and enforcement
promotion.

## Project documentation

- [Suite design](docs/design/suite.md) — architecture, CLI, cache, and exit-code contracts
- [Instruction-corpus design](docs/design/instruction-corpus.md) — shared agent-context evidence library
- [Prior art and the bar being raised](docs/design/prior-art.md)
- [Implementation plan](docs/plan/issues.md) and [check backlog](docs/plan/backlog.md)
- [Decisions (ACA series)](docs/decisions/README.md)
- [Release procedure](docs/release.md) — package verification, calibration, and npm handoff
- [Enforced standards](docs/standards/)
- [Contributing](CONTRIBUTING.md) and [agent context](AGENTS.md)
