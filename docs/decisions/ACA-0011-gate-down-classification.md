# ACA-0011: Gate-down classification — judge auth/quota rejection stops the run

**Status:** Accepted
**Date:** 2026-08-05
**Issue:** #11
**Extends:** [ACA-0003](ACA-0003-suite-contracts.md) D2's adapter degrade
contract and D3's exit-code table.

## Context

Observed live (2026-08-04, judging image-trail via an OpenAI-compatible
router): the account's included credits ran out mid-session, and every
subsequent judgment degraded to a per-file `warn (api error: 402 ...)`. The
run completed, exit 0, nothing judged. The suite already refuses to confuse
"couldn't judge" with "judged and passed" *at setup time* — missing
credentials exit 78 (`EX_CONFIG`) precisely so CI cannot read an unconfigured
gate as green. Quota or auth death at judge time is the same condition
arriving later, but it fell into the generic api-error → `warn` path built
for transient flakiness. Under `--enforce`, a depleted or revoked account let
every file through while the build stayed green.

## Decision

**Classify judge-transport errors; account rejection is gate-down and stops
the run.** Adapters throw `JudgeUnavailableError` (a sibling of
`MissingCredentialsError` in the JudgeClient port module) instead of
degrading when the transport rejects the *account* rather than the request:

- **Any wire:** HTTP 401, 402, 403.
- **OpenAI wire:** 429 with code `insufficient_quota` — OpenAI reports a
  depleted account as a 429, not a 402; any other 429 is rate limiting and
  stays transient.
- **Anthropic:** 400 whose message matches `credit balance is too low` —
  Anthropic reports a depleted account as a 400 `invalid_request_error`, not
  a 402; other 400s are per-request and stay transient.

Statuses are read duck-typed (`err.status`) so SDK `APIError`s and
proxy/local-server throws classify alike. The error propagates through the
check untouched — checks have no transport handling to update — and the CLI
stops the run with one line (`<check>: gate down — <provider> judge
unavailable — <note>`): exit 78 under `--enforce` or `--self-test`, exit 0
advisory. No per-file verdicts are emitted. Everything else — timeouts, 5xx,
plain 429, refusals, truncation, parse failures — keeps the ACA-0003 D2
degrade-to-`warn` behavior. A `warn` therefore still covers transient
faults where no judgment landed for that file (those are uncacheable and
retry next run); the narrowed guarantee is about the gate: account
rejection is never rendered as per-file warns that read as judgments.

## Why

- **Exit 78 rather than a sibling code.** Consumers already branch on 78 as
  "the gate is not operational — treat as its own signal, never as code is
  fine" (adoption recipe). A dead account is exactly that signal; a new code
  would force every consumer to update for no added distinction.
- **Advisory exits 0** to preserve advisory's never-blocks promise, matching
  the missing-credentials posture exactly — but the single notice names the
  outage instead of emitting warns that read as judgments.
- **`--self-test` exits 78, not 1:** an outage mid-calibration is not a
  fixture miss; reporting exit 1 would read as a disqualified judge.
- **Classification lives in the adapters** because only they see wire
  shapes; the port gains an error type, not a wider interface (the
  fork-don't-widen rule holds — `judge()` is unchanged).
- **Bounded retry for transients is already met:** both provider SDKs retry
  twice by default on connection errors, 408, 429, and 5xx before the
  adapter ever sees the failure. Documented here rather than rebuilt.

## Consequences

- `--enforce` can no longer stay green on a depleted, expired, or revoked
  account; CI distinguishes "code is fine" from "judge stopped looking"
  through the whole run, not just at setup.
- A gate-down mid-run abandons in-flight and unjudged files; verdicts
  already completed were cached, so the retry after refunding re-bills
  nothing.
- The two provider-specific shapes are message/code matches and can drift
  with provider APIs. The failure mode of drift is the old behavior
  (degrade to `warn`) — a regression to the prior status quo, not a new
  hazard — and the 401/402/403 floor never drifts.
- A misconfigured proxy returning blanket 403s stops the run rather than
  warning per file. Intended: that gate is genuinely not judging.
