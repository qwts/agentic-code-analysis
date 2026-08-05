# HTTP client retries

The HTTP client in [client.ts](../src/http/client.ts) retries transient
failures: `MAX_RETRIES` is 3, and only idempotent requests are retried.
