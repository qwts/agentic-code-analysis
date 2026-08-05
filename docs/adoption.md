# Adopting `aca` in a consuming repo

The recipe for the first advisory rollout (issue #6). Advisory only — the
check comments on structure; it cannot fail your build until the repo's owner
separately decides to promote it (see "Promotion" below). Your existing size
ratchet stays untouched: the contract is conjunctive — a change is good when
it passes the ratchet AND the semantic check.

## 1. `aca.config.json` at the repo root

```json
{
  "include": ["src/**"],
  "exclude": ["src/generated/**", "**/*.lock"],
  "tiers": {
    "T1": { "provider": "anthropic", "model": "claude-opus-5" }
  }
}
```

- `include`/`exclude`: the guarded source globs. Exclude generated files,
  vendored copies, and lockfiles — judging them wastes spend.
- `tiers`: provider/model per tier from the routing registry (ENG-0151);
  `context-footprint` and `doc-drift` both declare T1 (the CI step below
  applies to either check — swap the check name). `ACA_PROVIDER`/`ACA_MODEL`
  env vars override for one-off runs.
- Per-check sections nest under `checks`: `doc-drift` reads its document
  globs from `checks.doc-drift.include`/`exclude` (default `README.md` +
  `docs/**/*.md`; a configured include replaces the default, and an empty
  one is a config error, never a silent disable). Agent-instruction files
  (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `copilot-instructions.md`,
  anything under `.claude/`, `.cursor/`, or `.github/instructions/`) are
  hard-excluded regardless of globs. The top-level globs keep meaning
  "guarded source" — for `doc-drift` they scope which *changed code* is
  worth checking docs against, not which docs are read.
- Zero-egress option — **requires the adapters from issue #5
  ([PR #9](https://github.com/qwts/agentic-code-analysis/pull/9)); until that
  merges, `anthropic` is the only routable provider**:
  `{ "provider": "local", "model": "<loaded model>" }` judges against an
  OpenAI-compatible server on the runner (`ACA_LOCAL_BASE_URL`, default LM
  Studio's `http://localhost:1234/v1`) — no file content leaves the machine.

## 2. CI step (advisory)

There is no npm package yet (deliberate — Node refuses type stripping under
`node_modules`, and packaging waits for a second consumer). Check the suite
out beside your repo and run it directly with Node ≥ 24:

```yaml
jobs:
  aca:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0 # merge-base with origin/main needs history
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: qwts/agentic-code-analysis
          ref: <pin a commit sha>
          path: .aca
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
      - run: npm --prefix .aca clean-install
      - run: node .aca/src/cli.ts context-footprint --base origin/main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Behavior you can rely on (exit-code contract, ACA-0003 D3):

- Advisory always exits 0 — findings appear in the log, the job never blocks.
- Secret unset → one line (`context-footprint: skipped — no anthropic
  credentials resolve`), still exit 0. CI can distinguish "code is fine"
  from "judge never ran" the day it promotes to `--enforce` (exit 78).
- Key revoked or account depleted mid-run → the run stops with one line
  (`context-footprint: gate down — ...`): exit 0 advisory, 78 under
  `--enforce` — never per-file warns that read as judgments
  ([ACA-0011](decisions/ACA-0011-gate-down-classification.md)). Transient
  faults (timeouts, 5xx, rate limits) still degrade to `warn` per file.
- Unchanged semantic pairs across pushes cost zero API calls (verdict
  cache, D7 as extended by ACA-0013 — a moving merge-base does not re-bill);
  add `.cache/aca/` to the runner's cache action to carry it between runs
  (that exact subdirectory — `.cache/` would sweep up unrelated tooling).
  Observed spend: calibration + a 6-file change = $0.32 at T1
  (2026-08-04, claude-opus-5, prompt v1; v2 sends base+head for legacy
  files, roughly doubling those files' input tokens).
- `context-footprint` verdicts are comparative
  ([ACA-0013](decisions/ACA-0013-comparative-judgment.md)): a new file
  violating the rule fails; a legacy file made worse fails; a legacy file
  improved or held passes even while still violating, with the remaining
  debt named as **residual** findings
  (`pass (footprint improved; residual debt)` in text; `assessment` and
  `residualViolations` in `--json`). Residuals never block `--enforce`.
- `doc-drift` verdicts are absolute current-truth judgments over one doc
  plus its changed referents: `drifted` with a blocking criterion → `fail`;
  `incomplete` (new behavior undocumented) and `uncertain` → `warn`, never
  fail; `--json` carries `assessment`, structured `findings` with claims
  and reference ids, the selected `references`/`referents`, and `scanMode`
  (only explicit Markdown references are scanned — prose-only mentions are
  a documented miss). Advisory non-cacheable warns also cover unreadable
  referents, evidence-cap overflow, and malformed judge replies — a warn
  does not always mean `incomplete`/`uncertain`.

## 3. Local dev loop

```bash
node path/to/agentic-code-analysis/src/cli.ts context-footprint src/thing.ts
```

Explicit paths bypass diff selection; same verdicts, same cache.

## Scheduling residual debt (consumer contract)

Residual debt should be scheduled, not ambient. ACA stays a
platform-neutral verdict emitter — no GitHub tokens, issue search/creation,
or PR commenting, and no mutable issue URLs inside cached verdicts. A repo
that wants residuals turned into tracked cleanup work runs its own trusted,
least-privilege workflow over the `--json` output, with this contract:

- Deduplicate **one** cleanup issue per `check + normalized repo-relative
  path`, keyed by an exact machine-readable marker in the issue body (e.g.
  `<!-- aca:context-footprint:src/background/messages.ts -->`); search for
  the marker before creating, never create-or-comment on every run. When a
  verdict carries `basePath` (a rename), retain the base path as an alias
  of the same issue rather than opening a second one.
- On later PRs whose residuals match an existing marker, surface a pointer
  to that issue instead of restating the debt — nobody is taxed twice for
  a file they didn't make worse.
- Reconciliation failure (missing token, rate limit) is an integration
  signal for that workflow, never a semantic-check failure; the aca step's
  exit code must not depend on it.

The GitHub reconciler itself belongs in the consuming repo or its playbook,
as a follow-up there.

## Qualifying a judge (calibration levels)

Before trusting a provider/model route with real verdicts — and always
before `--enforce` — run the graded calibration on that exact route:

```bash
node path/to/agentic-code-analysis/src/cli.ts context-footprint --self-test --json
```

Exit 0 means the route reached the check's required qualification level
(`field` for context-footprint; `discrimination` for doc-drift — each check
ships its own graded exam, so qualify each check's route separately); the
JSON object records the evidence tuple —
prompt version, fixture-suite identity, provider, model, achieved level. That
qualification applies to that tuple only: requalify whenever you change the
model, the provider, or update ACA past a prompt/fixture change (the
fixture-suite identity moves with any of them). Passing `foundation` alone is
screening evidence — useful for shortlisting a cheap local judge, not
authority for enforcement or ratchet adjudication. Every self-test run bills
live API calls by design; it never reads or writes the verdict cache.

## Promotion to `--enforce`

Out of scope for adoption, deliberately. Run advisory, accumulate findings,
and let the repo owner decide promotion in their own issue on that evidence
(advisory-first gate promotion — the ratchet playbook's own shape). Flipping
the switch is adding `--enforce` to the CI step; the exit codes above are
already promotion-ready.
