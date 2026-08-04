# Plan: implementation issues

Five issues, each one reviewable PR-sized objective, in dependency order
(1 → 2 → 3; 4 and 5 independent after 3). Drafted here for design review and
**filed on approval (2026-08-04)** with the shared
[feature-lifecycle form](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/feature-lifecycle.md):
plan issue 1 → [#2](https://github.com/qwts/agentic-code-analysis/issues/2),
2 → [#3](https://github.com/qwts/agentic-code-analysis/issues/3),
3 → [#4](https://github.com/qwts/agentic-code-analysis/issues/4),
4 → [#5](https://github.com/qwts/agentic-code-analysis/issues/5),
5 → [#6](https://github.com/qwts/agentic-code-analysis/issues/6).
Every issue closes via a PR with `Closes #N`, opened by the bot identity, one
approving human review.

Decisions D1–D8 harden into `ACA-NNNN` records during #2. The ENG-0035
convention gives one record one originating issue number; eight decisions from
one design review is the known wrinkle — #2's implementer either consolidates
related decisions into records per embodying issue (suite contracts → 0003,
check judgment → 0004) or files one issue per decision, and records the choice.

**Routing note (all issues, per ENG-0151):** registry `verified_at` is
*never* — no refresh has run. Anthropic slots are seeded/provisional
(T1 `claude-opus-5`, T2 build `claude-sonnet-5`, T3 `claude-haiku-4-5`);
all other vendor groups are **unverified — cited as unknown, not guessed**.

---

## Issue 1 — Repo baseline and accepted design

**Problem.** The repo is a LICENSE and nothing else. Work cannot follow the
issue lifecycle in a repo missing its baseline (README, AGENTS.md,
CONTRIBUTING, CODEOWNERS, feature issue template), and the suite design
exists only as a review branch.

**Requirements.**
1. Baseline files per the shared repo-baseline SOP exist and pass its table.
2. `docs/design/`, `docs/plan/`, `docs/standards/` from the design review are
   merged, with review feedback applied.
3. Decisions D1–D8 are extracted to `docs/decisions/ACA-NNNN-*.md`, numbered
   by these issues, status Accepted, each with consequences including
   downsides.
4. Repo settings per baseline SOP (secret scanning + push protection,
   Dependabot security updates, private vulnerability reporting; CodeQL once
   code lands).

**Design.** Docs only, no code. Out of scope: CI workflows (issue 2), any
check logic.

**Proposed solution, with patterns.** Pattern: *repo-baseline reconciliation*
(the playbook-engineering scaffold). The design-review branch becomes this
issue's PR.

**Tier:** T3 — mechanical application of a written SOP; judgment already
spent in the design review. **Recommended:** Anthropic
`claude-haiku-4-5-20251001` (provisional). **Routing verified:** never (see
note). **Evidence:** the baseline SOP table checked row-by-row against the
repo listing fails before this PR and passes after.

---

## Issue 2 — Core: CLI frame, change scope, verdict cache, JudgeClient + Anthropic adapter

**Problem.** Checks need the three shared libraries and the dispatcher before
any check can exist; building them inside the first check would couple what
the design requires to stay separable.

**Requirements.**
1. `aca` dispatcher with `--help`, `--json`, `--enforce`, `--base`, exit
   codes exactly per the suite design table (0/1/2/78).
2. `change-scope`: changed files vs merge-base with `origin/main`,
   include/exclude globs from `aca.config.json`, explicit-path bypass.
3. `verdict-cache`: content-addressed store under `.cache/aca/`, gitignored;
   hit/miss visible in `--json` output.
4. `JudgeClient` interface + Anthropic adapter meeting the four adapter
   contract clauses (strict schema, degrade-to-warn, prefix caching where
   offered, no sampling knobs); SDK-standard credential resolution; missing
   credentials → one-line notice, exit 0 advisory / 78 enforce.
5. Unit tests for exit-code mapping, scope selection, cache keying; adapter
   tested against a stub transport (no live API in tests).
6. Every new file complies with the file-context-footprint standard the suite
   exists to enforce.

**Design.** Node ≥ 20, ESM, no runtime deps beyond provider SDKs
(devDependencies). Interfaces frozen as written in suite.md; a check needing
more forks, not widens. Out of scope: any judging logic, other adapters.

**Proposed solution, with patterns.** Patterns: *ports-and-adapters* (the
JudgeClient port), *content-addressed memoization*, *subcommand dispatcher*.

**Tier:** T2 — well-specified build against a reviewed design.
**Recommended:** Anthropic plan `claude-opus-5` / build `claude-sonnet-5`
(provisional). **Routing verified:** never (see note). **Evidence:**
`aca nonexistent-check` exits 2; `--enforce` with `ANTHROPIC_API_KEY` unset
exits 78 (a wrong implementation exits 0 or 1); cache-key test fails if any
key component is dropped.

---

## Issue 3 — The context-footprint check, with calibration self-test

**Problem.** Size ratchets in consuming repos catch the symptom but cannot
tell relocation from design; the rule that can is written down but
unenforced. An LLM judge without a regression harness drifts silently, so the
check and its calibration ship together — the check is not reviewable as
"done" without the self-test proving it can both pass and fail.

**Requirements.**
1. `aca context-footprint` implements the judge I/O of the check design:
   runtime-read rule text + instructions as cached system prefix; per-file
   user turn with content, import/imported-by paths, diff hunks, growth line.
2. Verdict schema exactly as designed; `fail` only for named criteria;
   ambiguity, refusal, truncation, parse failure → `warn` (with note).
3. Bounds: one file per request, concurrency 3, `max_tokens` 4096; verdicts
   memoized — second run on an unchanged branch makes zero API calls,
   verifiable from `--json` cache fields.
4. `--self-test` judges the two seed fixtures (enumerated union → `fail` with
   `relocation-not-design` or `duplicated-context`; composed version →
   `pass`) and exits non-zero on any assertion miss.
5. Prompt version pinned as a string; bumping it invalidates the cache
   (covered by issue 2's key test).
6. Script files comply with the standard they enforce (self-application).

**Design.** Constraints: no vendor SDK imports in the check (JudgeClient
only); rule text never paraphrased into code. Touchpoints: the three core
libraries, `docs/standards/file-context-footprint.md`. Out of scope:
consumer CI wiring, non-Anthropic adapters.

**Proposed solution, with patterns.** Patterns: *LLM-as-judge with golden
fixtures* (new — name it `calibrated-judge`), *rubric-in-system/payload-in-user*
prompt split. Prompt iteration loop: run self-test → fix prompt (never
fixtures) → bump version → re-run.

**Tier:** T1 — the deliverable is judgment quality; the diff size disagrees
with the tier and the tier wins. **Recommended:** Anthropic `claude-opus-5`,
reasoning high (provisional). **Routing verified:** never (see note).
**Evidence:** the self-test is the evidence — it fails on a prompt that
cannot discriminate the fixture pair, and the enumerated fixture failing
`pass` is the negative control that proves the gate can gate.

---

## Issue 4 — OpenAI and local adapters

**Problem.** D2 (provider interchangeability) is untested with one adapter;
the claim is only real when a second and third provider pass the same
calibration.

**Requirements.**
1. OpenAI adapter (structured outputs) and local adapter (OpenAI-compatible
   base URL, e.g. LM Studio/Ollama) meeting the full adapter contract.
2. No change to any check — the diff proves the port boundary held.
3. `--self-test` runs per configured provider; a provider failing calibration
   is reported and documented as unsupported for the check, not shipped
   quietly worse.
4. Tier map in `aca.config.json` selects provider/model per the ENG-0151
   pattern; local adapter documented as the zero-egress option.

**Design.** Out of scope: provider benchmarking, cost dashboards, any new
check. **Proposed solution, with patterns.** Pattern: *ports-and-adapters*
(second/third adapter proves the port).

**Tier:** T2. **Recommended:** Anthropic build `claude-sonnet-5`
(provisional); OpenAI/local model choices for the *adapters under test* come
from the tier map at run time, not this issue. **Routing verified:** never
(see note). **Evidence:** `git diff --stat` for the PR touches zero files
under `checks/`; self-test green on Anthropic + at least one other provider,
or a recorded unsupported verdict.

---

## Issue 5 — Consumer adoption recipe and first advisory rollout

**Problem.** The suite is only real when a repo consumes it; adoption steps
left to each consumer will be reinvented divergently.

**Requirements.**
1. A documented recipe: `aca.config.json` (include/exclude, tier map) plus a
   CI step running `aca context-footprint` advisory.
2. First consuming repo adopts it advisory-only in its own PR; that repo's
   ratchet remains untouched (the contract is conjunctive — the semantic check
   complements the ratchet, never replaces it).
3. Promotion to `--enforce` is explicitly out of scope — a separate
   owner-decided issue in the consuming repo, made on advisory evidence.
4. Spend observed for a typical change reported on the issue (target: ~5-file
   change under ~$0.50 at T1).

**Design.** Out of scope: composite action / reusable workflow packaging —
worth doing only after two consumers exist; blocking the first adoption on
packaging is the wrong order.

**Proposed solution, with patterns.** Pattern: *advisory-first gate
promotion* (the ratchet playbook's own adoption shape).

**Tier:** T3 — mechanical wiring from a written recipe. **Recommended:**
Anthropic `claude-haiku-4-5-20251001` (provisional). **Routing verified:**
never (see note). **Evidence:** a deliberately mis-organized file pushed to a
scratch branch in the consuming repo produces a `fail` finding in the
advisory CI log while the job still exits 0; unsetting the API secret flips
the step to the one-line notice, still exit 0.
