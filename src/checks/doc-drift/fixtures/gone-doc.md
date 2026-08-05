# Delay jitter

Every retry delay is randomized so synchronized clients spread out instead
of stampeding. The randomization lives in
[jitter.ts](../src/retry/jitter.ts): call `computeJitter` with the base
delay to get the randomized wait. All retry paths go through it.
