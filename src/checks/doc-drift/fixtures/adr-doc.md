# ADR-0007: Exponential backoff for retries

**Status:** Accepted 2025-03-10; amended 2025-11-02.

## Context

The first implementation (March 2025) used a fixed schedule: three retries,
one second apart, hardcoded in `withRetry`. Under production load the fixed
schedule synchronized failing clients into thundering herds, and three
attempts proved too few for flaky upstreams.

## Decision (current)

Exponential backoff in [backoff.ts](../src/retry/backoff.ts):
`DEFAULT_RETRIES` is 5, and the delay doubles on each attempt starting from
`baseDelayMs` (default 100 ms). The old fixed schedule is gone.
