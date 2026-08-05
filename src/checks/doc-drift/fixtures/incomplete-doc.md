# Tuning retries

`DEFAULT_RETRIES` (5) bounds how many times a failed call is retried by
[backoff.ts](../src/retry/backoff.ts). `baseDelayMs` sets the initial delay
(default 100 ms), and each subsequent attempt doubles it. Override either
per call through `RetryOptions`.
