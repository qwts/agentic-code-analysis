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
  `context-footprint` declares T1. `ACA_PROVIDER`/`ACA_MODEL` env vars
  override for one-off runs.
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
- Unchanged files across pushes cost zero API calls (verdict cache, D7);
  add `.cache/aca/` to the runner's cache action to carry it between runs
  (that exact subdirectory — `.cache/` would sweep up unrelated tooling).
  Observed spend: calibration + a 6-file change = $0.32 at T1
  (2026-08-04, claude-opus-5).

## 3. Local dev loop

```bash
node path/to/agentic-code-analysis/src/cli.ts context-footprint src/thing.ts
```

Explicit paths bypass diff selection; same verdicts, same cache.

## Promotion to `--enforce`

Out of scope for adoption, deliberately. Run advisory, accumulate findings,
and let the repo owner decide promotion in their own issue on that evidence
(advisory-first gate promotion — the ratchet playbook's own shape). Flipping
the switch is adding `--enforce` to the CI step; the exit codes above are
already promotion-ready.
