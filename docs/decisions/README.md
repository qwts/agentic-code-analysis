# ACA decisions

Repo-local decision records (this repo is single-owner scope; cross-repo
decisions belong in the
[ENG series](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/README.md)).
Format and lifecycle follow the ENG conventions: context / decision / why /
consequences including downsides; statuses `Proposed`, `Accepted`,
`Superseded by ACA-NNNN`; records are never rewritten after acceptance.

Numbering follows ENG-0035 (record number = originating GitHub issue number),
with one recorded delta: the founding design review (PR #1 / issue #2)
produced eight decisions at once, so they are consolidated per *embodying*
issue — suite contracts under the core-build issue, judgment semantics under
the check issue — rather than one issue per decision.

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ACA-0003](ACA-0003-suite-contracts.md) | Suite contracts — CLI shape, JudgeClient, exit codes, output, model routing, verdict cache (D1–D4, D6, D7) | Accepted; D7 key extended by ACA-0013 |
| [ACA-0004](ACA-0004-context-footprint-judgment.md) | Context-footprint judgment — file-as-it-stands, load-set accounting, fixture-gated prompts (D5, D8) | Accepted; D5 superseded for legacy files by ACA-0013; D8 graded by ACA-0012 |
| [ACA-0011](ACA-0011-gate-down-classification.md) | Gate-down classification — judge auth/quota rejection stops the run, exit 78 | Accepted |
| [ACA-0012](ACA-0012-graded-calibration.md) | Graded calibration — qualification levels, validated exam, machine-readable evidence | Accepted |
| [ACA-0013](ACA-0013-comparative-judgment.md) | Comparative judgment — direction of change for legacy files, pair-addressed cache | Accepted |
| [ACA-0014](ACA-0014-naming-truth.md) | naming-truth — behavioral contract, three lies, host-enforced comparative mapping | Accepted |
| [ACA-0020](ACA-0020-diff-fixture-corpus.md) | Diff-fixture corpus and the canonical diff artifact — pair fixtures, diff judge I/O convention | Accepted |
