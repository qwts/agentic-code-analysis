<!--
Authoritative rubric for `aca failure-posture` (issue #18). This file is read
at runtime and embedded verbatim in the judge prompt — edits here change
judgments and require a prompt-version bump plus recalibration. The design doc
(docs/design/check-failure-posture.md) owns execution policy; this file owns
what the criteria mean.
-->
# Failure posture: behavior when dependencies misbehave

Code is reviewed for what it does when its dependencies behave; incidents come
from what it does when they don't. This rubric judges one file's posture
toward its external dependencies.

**An external dependency is an effect boundary outside the current process's
deterministic memory:** network services, durable local or remote storage,
queues/brokers, or subprocesses. Clock and randomness use, in-memory state,
and pure computation are not external dependencies.

## The practical test

> For each external dependency this file touches: what does this code do when
> that dependency is **slow**, **down**, or **lying** (returning errors,
> malformed data, or partial results)?

A finding is the concrete misbehavior scenario — *"if this endpoint hangs,
every worker thread blocks forever"* — anchored to the code. The criterion is
only its label.

## Criteria (the closed set)

- **`missing-timeout`** — a finite operation has no visible deadline,
  cancellation, or propagated caller signal, so a slow or hung dependency can
  occupy work indefinitely. *Not a violation when* the call receives a
  caller-provided signal or an explicitly configured client policy; a
  long-lived stream needs lifecycle/cancellation, not an arbitrary request
  timeout.
- **`retry-without-backoff`** — retries immediately or on a fixed hot
  cadence, amplifying an outage into a self-inflicted flood. Missing jitter
  alone fails only when synchronized fan-out is supported by file-local
  evidence.
- **`unbounded-retry`** — retry attempts have no count limit, total
  deadline, or cancellation bound.
- **`swallowed-failure`** — a failure is caught or ignored and normal
  processing reports or behaves as if the work succeeded. An explicit bounded
  fallback or declared best-effort telemetry is not a violation.
- **`unbounded-buffering`** — externally controlled input accumulates
  without a size limit or backpressure.
- **`stampede-prone`** — a visible concurrent miss/refresh path can launch
  duplicate fills against the same dependency without coalescing
  (single-flight, lock, or equivalent).
- **`unchecked-external-result`** — an error status or malformed/partial
  result is treated as valid despite a file-visible contract. Do not demand
  speculative validation where no contract is visible in the file.

Unknown SDK or wrapper behavior is uncertainty, never a guessed failure.

## Boundary with security review

This rubric owns **operational** consequences: availability, latency and
resource exhaustion, durability and data loss, false operational success, and
stale or corrupt operational state. Security consequences of error paths —
authentication/authorization failing open, privileged work continuing after a
failure, trust-boundary bypass, secret or PII exposure — belong exclusively
to a separate security check and must not be reported here. If one code path
has an independent operational consequence, report only that operational
scenario.
