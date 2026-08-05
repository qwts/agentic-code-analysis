# Retry policy

Transient HTTP failures (a 503 during a deploy, a dropped connection) used
to fail the whole operation on the first attempt. Every HTTP helper now
threads a `RetryPolicy`:

- `attempts` — total attempts including the first; `1` disables retry.
- `backoffMs` — linear backoff base; attempt `n` waits `n * backoffMs`
  before retrying.

`defaultPolicy` is 3 attempts at 250ms base backoff. Call sites that must
not retry (non-idempotent writes) pass `{ attempts: 1, backoffMs: 0 }`
explicitly. Tuning happens in one place: pass a different policy at the
boundary instead of sprinkling ad-hoc retry loops through call sites.
