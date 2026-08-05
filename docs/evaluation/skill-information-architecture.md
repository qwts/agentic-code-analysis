# Skill information architecture evaluation protocol

This protocol consumes the generic `--json` result from
`skill-information-architecture`; the check has no dependency on a target-agent
harness or SkillOpt. The prompt version, fixture-suite digest, provider/model
route, estimator, task manifest, package tree, scorer, seeds, and tool budget
must be frozen in every recorded run.

## Static grader qualification

Calibration development and any independent evaluation corpus use disjoint
case ids. Keep prompt-development, held-out selection, and final-test ids
separate. Report macro-F1 across the four rubric criteria, exact evidence-span
accuracy, non-overlapping actionable-edit validity, and abstention recall for
unknown-frequency cases. A model arithmetic match is not a metric: paths,
spans, edits, tokens, and opens are host-verified.

The shipped checksummed calibration exam is a qualification gate rather than
the final score set. Its `foundation`, `coverage`, and required `boundaries`
levels pin the minimum behaviors needed before a configured route is trusted.

## Target-agent A/B handoff

For each `measurementSeed`, run the same task and seed against the baseline
package and the candidate produced by the bounded `add | delete | replace`
export. Instrument actual resource reads and report:

- hard task success overall and by common, specialist, and critical cohort;
- activated-body tokens and total loaded tokens per task (mean and p95);
- resource opens, required-resource read recall before the first consequential
  command, unnecessary-read rate, and success per 1,000 loaded tokens.

Correctness gates efficiency. Accept a candidate only when held-out task
success does not regress and context cost improves, or when a preregistered
correctness-first composite strictly improves. Choose on held-out data and
touch the sealed test split once. Fewer lines or tokens alone is never success.

## Run record

Store a bounded JSON record with this shape:

```json
{
  "schemaVersion": 1,
  "runId": "stable-id",
  "grader": {
    "promptVersion": "skill-information-architecture-v5",
    "fixtureSuite": "sha256:...",
    "provider": "resolved-from-config",
    "model": "resolved-from-config"
  },
  "artifacts": {
    "baselineDigest": "sha256:...",
    "candidateDigest": "sha256:...",
    "taskManifestDigest": "sha256:...",
    "harnessDigest": "sha256:...",
    "scorerDigest": "sha256:..."
  },
  "split": "held-out",
  "seeds": [1, 2, 3],
  "scoreSummary": {}
}
```

Do not commit raw trajectories or unbounded telemetry. Live target-agent A/B
execution belongs in a sibling evaluation effort; the usable check, verified
edit export, calibration gate, and this frozen protocol are complete without a
production harness adapter.
