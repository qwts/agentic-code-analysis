# Semantic ratchets

Numeric ratchets remain the deterministic merge gate; `aca context-footprint`
adds the missing design judgment as advisory feedback. A cheap, calibrated
Hugging Face route screens ordinary pull requests. An authoritative judge is
required only to grant a per-file ceiling exception or settle a disputed
screening result. No model call belongs in a commit or push hook.

Decision record: [ENG-0160](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0160-semantic-judge-arbitrates-size-ratchets.md).
Tool contract and calibration mechanics live in this repository; the reusable
workflow is [`.github/workflows/semantic-ratchet.yml`](../../.github/workflows/semantic-ratchet.yml)
(moved here from `qwts/agent-sop` in qwts/agent-sop#379).

## The two dimensions

The ratchet reports movement; the semantic judge reports whether the resulting
boundary is coherent. Neither result can stand in for the other.

| Numeric ratchet | Semantic screen | Action |
| --- | --- | --- |
| Pass | Pass | Proceed; no exception is involved. |
| Pass | Fail or warn | Keep the numeric pass, surface the structural finding, and schedule agreed residual debt. Do not manufacture a size failure. |
| Fail | Pass | Do not raise the global ceiling. Request a per-file exception and obtain an authoritative pass on that exact change. |
| Fail | Fail or warn | No exception. Keep the ratchet failure and use the named seams to plan the correction. |

The screen is intentionally advisory. Its purpose is to catch relocation and
boundary degradation that a line count cannot see, not to turn every model
opinion into a required status check.

## Execution lanes

| Lane | Route | Frequency | Effect |
| --- | --- | --- | --- |
| Deterministic ratchet | Repository-native script | Local validation and CI | Blocking |
| Local semantic review | Any explicitly selected qualified route | On demand after boundary-changing work | Advisory |
| Pull-request screen | Hugging Face through its OpenAI-compatible endpoint | Once per ready revision | Advisory |
| Exception adjudication | Authoritative T1 judgment route | Only for an exception or dispute | Required evidence for that decision |

Do not add the semantic command to `pre-commit`, `prepare-commit-msg`, or
`pre-push`. Those hooks must not depend on a secret, network service, variable
latency, or an account balance. An agent or developer may run the local command
explicitly before review:

```bash
ACA_PROVIDER=openai \
ACA_MODEL='<exact-hf-model-and-provider-route>' \
OPENAI_BASE_URL='https://router.huggingface.co/v1' \
OPENAI_API_KEY="$HF_TOKEN" \
node /path/to/agentic-code-analysis/src/cli.ts context-footprint --base origin/main
```

`openai` here names aca's wire adapter. The endpoint and exact model/provider
route identify Hugging Face operationally. Do not use a dynamic `:cheapest` or
`:preferred` suffix for a qualified route: the underlying provider could
change without the qualification identity changing.

## Qualifying a route

Qualification belongs to the exact tuple of aca commit, check, prompt version,
fixture-suite identity, endpoint, model, and underlying provider. Before a new
route screens production changes, run:

```bash
ACA_PROVIDER=openai \
ACA_MODEL='<exact-hf-model-and-provider-route>' \
OPENAI_BASE_URL='https://router.huggingface.co/v1' \
OPENAI_API_KEY="$HF_TOKEN" \
node /path/to/agentic-code-analysis/src/cli.ts context-footprint --self-test --json
```

For `context-footprint`, only the required `field` level qualifies a route for
screening or adjudication. A foundation-only result is useful for eliminating
a bad candidate, not for granting a ceiling exception. Requalify when any
element of the tuple changes. Instability is a miss; do not average verdicts.

Cost does not confer authority. A low-cost route that passes the required exam
may screen broadly. An exception still uses the owner-approved authoritative
route until repeated field evidence supports changing that policy.

## Reusable advisory workflow

The shared workflow pins aca and every third-party Action by commit. The caller
pins the workflow itself to a reviewed commit of this repository, supplies its
guarded-source globs in `aca.config.json`, passes an exact Hugging Face
model/provider route, and maps its repository secret:

```yaml
jobs:
  semantic-ratchet:
    uses: qwts/agentic-code-analysis/.github/workflows/semantic-ratchet.yml@<reviewed-commit-sha>
    with:
      model: '<exact-hf-model-and-provider-route>'
    secrets:
      HF_TOKEN: ${{ secrets.HF_TOKEN }}
```

The workflow deliberately omits `--enforce`; semantic fail verdicts are
findings, not a merge gate. A missing token produces aca's explicit advisory
skip. Fork pull requests therefore do not require exposing a repository secret.
The caller must never switch to `pull_request_target` to make the secret
available to untrusted fork code.

Verdicts are content-addressed under `.cache/aca/`. The shared cache reduces
repeat billing but does not change a verdict: provider, model, prompt, rubric,
and compared content are already part of aca's semantic cache key.

To qualify a route through the same pinned workflow, create a manually
dispatched caller and set `qualify: true`. Qualification is live and uncached;
the job fails on a fixture miss or unavailable judge.
