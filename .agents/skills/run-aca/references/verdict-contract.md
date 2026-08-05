# ACA verdict contract

Read this reference when a run is not a clean qualified pass, when ACA emits no
JSON, or before a result affects enforcement.

## Locate the result

A normal `--json` analysis writes one object containing `check`, `provider`,
`model`, and `verdicts`. Each verdict includes `file`, `verdict`, `cached`, and
`violations`, plus check-specific evidence. A self-test writes one qualification
object instead. Missing credentials and gate-down notices may arrive on stderr
without JSON, including advisory runs that exit 0.

Never parse stderr as a semantic verdict. Never claim the checked code is clean
when a structured result is absent.

## Interpret process status in context

| Status | Advisory analysis | `--enforce` | `--self-test` |
| --- | --- | --- | --- |
| 0 | Command completed; inspect every verdict because fails may exist | No blocking fail verdicts | Required qualification level reached |
| 1 | Not used for findings | At least one blocking fail | Calibration level missed |
| 2 | Invalid usage or configuration | Invalid usage or configuration | Missing self-test or invalid calibration/configuration |
| 78 | Not used; gate-down advisory instead exits 0 with a notice | Credentials absent or judge account unavailable | Credentials absent or judge account unavailable |

An advisory credentials or account outage exits 0 so local feedback does not
block work. The outage notice proves that the judge did not establish a result.

## Interpret verdicts

- `fail`: blocking semantic evidence for that check. Advisory mode still exits
  0; enforcement exits 1 when any fail exists.
- `warn`: uncertainty, incomplete evidence, transport/schema degradation, or a
  check-specific nonblocking condition. Preserve the note and do not upgrade it
  to pass.
- `pass`: no blocking finding. Inspect subtype fields before calling it clean.
  `residualViolations` records pre-existing nonblocking debt on comparative
  checks; `skipped: true` records a mechanical non-applicability decision rather
  than a judge's semantic approval.
- `cached`: reports whether ACA reused the same semantic judgment. It does not
  change severity.

Retain check-specific `assessment`, evidence, omissions, scan coverage,
partition coverage, or topology fields when they explain the result. A summary
must not erase the distinction between blocking violations, residual debt,
uncertainty, incomplete coverage, and a mechanical skip.

## Interpret qualification

Trust only the exact tuple returned by the self-test: check, prompt version,
fixture-suite identity, provider, model, achieved level, and required level.
Qualification does not transfer across checks or after any tuple component
changes. A self-test is live and billable; a cached production verdict is not a
substitute for qualification.
