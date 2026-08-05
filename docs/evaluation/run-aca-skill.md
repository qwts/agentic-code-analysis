# `run-aca` skill evaluation

Run date: 2026-08-05. Candidate: `.agents/skills/run-aca/` on issue #57.
Six clean-context agents received only the installed skill path and one bounded
task. They could inspect the repository but could not edit files or make
billable judge calls. Each prompt began with: “Read and follow the `$run-aca`
skill at `.agents/skills/run-aca/SKILL.md`. From that repository, handle this
scenario without executing billable calls or editing files.” This record keeps
prompts and observable traces, not raw trajectories.

| Scenario | Expected behavior | Observed behavior | Result |
| --- | --- | --- | --- |
| Single file | Select the file-oriented check and keep an explicit path | Chose `context-footprint --json src/core/config.ts`, preserved the caller's repository root, and did not add enforcement | pass |
| Documentation change | Treat the changed doc as a referent seed and let the check discover tracked docs | Chose `doc-drift --json --base origin/main docs/adoption.md`, explained why `README.md` must not be positional, and made no billable call | pass |
| Whole skill package | Select the package check, sidecar, and topology-specific result fields | Chose `skill-information-architecture --json .agents/skills/run-aca`, expected workload-grounded evidence, and kept the unqualified route explicit | pass |
| Advisory fail | Do not infer clean code from status 0 | Preserved the blocking fail, cache/provider/model fields, and required qualification before any enforced rerun | pass |
| Gate down | Treat empty stdout plus a credential notice as no judgment | Reported the self-test as skipped rather than pass/warn/fail and prescribed credential setup plus an exact rerun | pass |
| No enforcement authority | Prepare an advisory change run without mutation | Chose `context-footprint --json`, omitted `--enforce`, and did not execute it | pass |

## Prompts and traces

1. **Single file.** Prompt: “Prepare the command to analyze
   `src/core/config.ts` with ACA and explain the selected check, scope, and
   qualification state.” Trace: read the live help/catalog, returned
   `scripts/run-aca context-footprint --json src/core/config.ts`, and stated
   that the configured route was not qualified. No command was executed.
2. **Documentation change.** Prompt: “Choose the ACA command for checking
   whether the current `docs/adoption.md` change makes tracked documentation
   stale. Prepare it only.” Trace: read help, README, and the selected design;
   returned `scripts/run-aca doc-drift --json --base origin/main
   docs/adoption.md`; explained that the positional path is the changed
   referent seed and tracked docs are discovered by the check.
3. **Whole skill package.** Prompt: “Prepare the exact advisory ACA command to
   assess the information architecture of the local `run-aca` skill package
   itself. Explain the selected scope, whether qualification has been
   established, and what you would verify in the result.” Trace: read help,
   the selected design, and the workload sidecar; returned `scripts/run-aca
   skill-information-architecture --json .agents/skills/run-aca`; expected a
   complete, workload-grounded package and reported the route unqualified.
4. **Advisory fail.** Prompt supplied a structured fail verdict with command
   status 0 and asked for an interpretation and next action. Trace: loaded the
   verdict reference, retained the fail as blocking semantic evidence, named
   cache and returned route identity, and required a matching billable
   self-test before any authorized enforced rerun.
5. **Gate down.** Prompt supplied empty stdout, status 78, and stderr
   `skill-information-architecture: skipped — no anthropic credentials
   resolve` from `--self-test --json`. Trace: loaded the verdict reference,
   reported that no judge result existed, and prescribed configuring the route
   before rerunning the same command; it made no pass/warn/fail claim.
6. **No enforcement authority.** Prompt: “Prepare the exact command to analyze
   the current repository changes with ACA. Do not execute billable calls or
   edit. I have not asked for enforcement.” Trace: returned `scripts/run-aca
   context-footprint --json`; explicitly noted that `--enforce` was omitted and
   did not execute the command.

All six scenarios passed on their first candidate-skill attempt, so no skill
iteration was attributed to forward-test failures.

The package also passed its static contract, live-corpus discovery, launcher
resolution, argument-preservation, exit-status, and preflight tests. The real
launcher returned the live check catalog from the checkout.

## Live qualification and self-dogfood

Authorized live qualification exposed a prompt/verifier contract gap rather
than a fixture defect. Across the screened routes, valid semantic proposals
were degraded when preservation spans were repeated, workload-grounded
background preceded the routine path, or missing workload evidence was treated
as a clean placement decision. The prompt was tightened without changing the
fixtures, schema, verifier, rubric, or 4,096-token bound, and its pinned version
was advanced to `skill-information-architecture-v5`.

The final uncached qualification tuple was:

- check: `skill-information-architecture`;
- prompt: `skill-information-architecture-v5`;
- fixture suite: `sha256:d6a4208ba137d2ef`;
- provider/model: `anthropic` / `claude-opus-5`;
- achieved/required level: `boundaries` / `boundaries`;
- result: qualified, all nine fixtures passed;
- elapsed time: 59.59 seconds.

The subsequent advisory run targeted `.agents/skills/run-aca`, serialized all
four package files with six workload scenarios and no omissions, and returned
an uncached `well-structured` / `pass` verdict with zero findings. The package
contained 883 activated-body tokens and three on-demand resources. Elapsed
time was 24.22 seconds.

Route screening stayed bounded and stopped higher-level spend after each miss.
The notable completed attempts were: Qwen3.5-397B thinking output truncated at
the 4,096-token cap (73.73s); Qwen3-235B Instruct missed host-verified routing
or grounding (31.77s on v1, 43.35s on v2); Qwen2.5-72B Instruct missed a
preservation or proposal invariant (61.17s on v1, 27.86s on v2); Llama 4 Scout
returned non-patchable findings (17.82s); DeepSeek V4 Pro over-flagged the
known-good fixture (44.10s); and Opus progressed from foundation on v1/v2/v3
(62.05s, 61.38s, 52.51s) to coverage on v4 (55.91s) and boundaries on v5.
One Kimi K2.6 attempt was terminated without a result after 218.77 seconds and
is not qualification evidence.

Later `qwen3.8-max-preview` screening isolated the transport-budget effect.
Default thinking consumed the shared 4,096-token completion allowance and
returned no verdict after 102.13 seconds. No-thinking and bounded-thinking
routes both achieved only `foundation` against required `boundaries`; the
bounded-thinking run took 66.59 seconds. The dedicated adapter decision in
[ACA-0064](../decisions/ACA-0064-qwen-reasoning-budgets.md) prevents hidden
reasoning from consuming the visible JSON-answer allowance, but it does not
turn that measured semantic miss into a qualification. The route remains
unqualified. Direct post-implementation validation, with no proxy, completed
in 65.20 seconds: strict-schema transport succeeded, one of four coverage
controls passed, three missed, and the route again achieved only `foundation`.
