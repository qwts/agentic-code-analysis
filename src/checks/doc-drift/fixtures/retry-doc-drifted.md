# Retry behavior

Failed calls retry with exponential backoff, implemented in
[backoff.ts](../src/retry/backoff.ts). `DEFAULT_RETRIES` is 3: a call is
attempted at most four times before the last error is rethrown.

Pass `retries` in `RetryOptions` to override the default of three retries;
`baseDelayMs` (default 100) sets the initial delay, which doubles on each
subsequent attempt.
