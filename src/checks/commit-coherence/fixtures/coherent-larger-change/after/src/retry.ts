// Retry policy for transient HTTP failures: how many attempts to make and
// how long to back off between them. One policy object threads through
// every call site so operational tuning happens in one place.

export interface RetryPolicy {
  /** Total attempts, including the first (1 = no retry). */
  attempts: number;
  /** Base delay; attempt n waits n * backoffMs before retrying. */
  backoffMs: number;
}

export const defaultPolicy: RetryPolicy = { attempts: 3, backoffMs: 250 };

/** Run `operation`, retrying per the policy; the last error propagates once
 * the attempt budget is spent. */
export async function withRetry<T>(policy: RetryPolicy, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < policy.attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * policy.backoffMs));
      }
    }
  }
  throw lastError;
}
