// Check-local worker pool. Production judging and calibration share this one
// bound (check design: concurrency 2 — partitions are large requests) so the
// self-test cannot exceed what the check itself is allowed to send.
export const CONCURRENCY = 2;

export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
