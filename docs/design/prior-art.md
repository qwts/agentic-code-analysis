# Prior art: where this suite sits, and how it raises the bar

Survey of the mid-2026 landscape, condensed to what shaped the
[suite design](suite.md). Vendor accuracy claims in this space are almost
universally self-reported; treat every number below accordingly.

## LLM review tools (the adjacent incumbents)

- **CodeRabbit** — App + CLI; has an agent-oriented compact output mode
  (`review --agent`), validating D4's token-budget output as a real need.
  Hosted proprietary models only; review exit codes undocumented — gating is
  not a first-class contract.
- **Greptile** — CLI with documented exit codes, but they signal *completion*,
  not *verdict* (nonzero = couldn't run). The conflation we explicitly avoid:
  our 0/1/2/78 table separates "judge said no" from "judge unavailable".
- **Qodo PR-Agent** — the closest provider-agnostic precedent (LiteLLM
  multi-model, TOML config), but PR-comment-centric, no verdict caching, and
  the OSS core is now legacy behind a paid product.
- **Ellipsis / Sourcery / Copilot code review** — App/comment UX, no CLI gate
  contract. Copilot's convergence on repo-markdown rubrics
  (`copilot-instructions.md`, `AGENTS.md`) confirms the convention D5 relies
  on: the rule lives as markdown in the repo, read at runtime.
- **Alibaba open-code-review** — open CLI, deterministic pipeline + LLM
  judge, OpenAI/Anthropic-compatible, JSON export; benchmarks a purpose-built
  reviewer at ~1/9 the tokens of a general agent. Closest architectural
  cousin; aimed at bug/security review, not structure.
- **Cloudflare's internal reviewer** (published design, not a product) — the
  only public evidence of a *hard-blocking* LLM gate at scale: strict
  rubrics, tiered model routing by risk, 85% prompt-cache hit rate, and a
  "break glass" override valve it needed to be socially survivable. Lesson
  adopted: advisory-first (D3); an override valve is the future work item if
  `--enforce` promotion ever feels contentious.

## Mechanical analyzers (the contrast set)

CodeScene (code-health delta gates, change coupling), SonarQube (cognitive
complexity quality gates), ESLint boundaries / dependency-cruiser (declared
architecture edges), ast-grep/Semgrep (structural patterns; Semgrep
Assistant's deterministic-finder + LLM-triage hybrid validates the shape).
All of them gate on *proxies* for cohesion — size, complexity, fan-in/out,
historical coupling. None can judge "this file is two concepts glued
together" or "this split increased the load-set". That judgment is the open
slot this suite occupies, and why the contract with ratchets is conjunctive
rather than competitive.

CodeScene's *delta* gating (fail only on decline in changed code) is the
right adoption politics and is mirrored by our change-scope design: judge
only what the change touched.

## "LLM lint" prior art

GenAIScript's TLA+ AI linter (rubric-per-file prompt, SARIF out), GitHub
Models `gh models eval` (rubric files + judge in CI, for prompts not code),
and a handful of early projects (lllint, plan-lint) — the pattern exists;
none ship CI-gate rigor, caching, or calibration. SARIF + reviewdog is the
proven adapter layer for surfacing findings as PR annotations without
building a GitHub App — the reason D4 keeps `--json` as the stable contract:
a SARIF formatter is a thin, later addition, not an architecture decision.

## The bar, raised — what none of the incumbents do

Each maps to a decision already in the design:

1. **Deterministic verdict caching by content hash** (D7) — no shipping tool
   makes unchanged files free and reruns byte-identical. This is what makes
   an LLM gate *behave like a linter*.
2. **Calibration self-test with golden fixtures** (D8) — every incumbent
   asks you to trust vendor-self-reported accuracy; none ships a
   `--self-test` the operator can run against known-pass/known-fail
   fixtures when the model or prompt changes.
3. **Verdict-vs-availability exit-code contract** (D3) — advisory/enforce
   modes with distinct codes for "fail" (1) vs "cannot judge" (78) has no
   incumbent.
4. **Provider-agnostic judging with auditable verdicts** (D2, D7) — the
   cache key pins model id + prompt version, so every verdict is
   reproducible and attributable after the fact.
5. **File-level semantic cohesion as the check itself** — no incumbent
   judges the thing the context-footprint standard names; mechanical tools
   proxy it, review bots don't look for it.
6. **Token-efficient agent output as the design center, not a mode** (D4).
7. **Small, loosely coupled checks over a monolith** (D1) — every incumbent
   is an App or an all-in-one CLI; composable JSON-emitting checks have no
   incumbent.
