// The context-footprint check: orchestrates rule text, per-file comparisons,
// the verdict cache, and the judge (operational bounds per the check design:
// one file per request, concurrency 3, max_tokens 4096).
import { normalize } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { buildComparisons, type Comparison, type Snapshot } from './comparison.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from './judge-io.ts';
import { selfTest } from './self-test.ts';

const CONCURRENCY = 3;

/**
 * Pair-addressed key (ACA-0013 extending ACA-0003 D7): every semantic input
 * to the comparative judgment — kind, both snapshots' identity, content, and
 * import edges — plus rule, prompt version, provider, model. Base ref/SHA,
 * hunks, and line counts are excluded: identity-independent or derived, so a
 * moving merge-base cannot re-bill an unchanged semantic pair.
 */
function cacheKey(comparison: Comparison, rule: string, provider: string, model: string): string {
  const snapshot = (s: Snapshot): string[] => [s.path, s.content, JSON.stringify(s.imports), JSON.stringify(s.importedBy)];
  const base = comparison.kind === 'legacy' ? snapshot(comparison.base) : ['(no base)'];
  return VerdictCache.key([PROMPT_VERSION, comparison.kind, ...base, ...snapshot(comparison.head), rule, provider, model]);
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rule = ruleText();
  const system = systemPrompt(rule);
  // Normalize so explicit ./src/x.ts matches the repo-relative graph and key
  // (review finding, PR #8); dedupe so one path cannot race the pool and
  // bill twice (ACA-0013).
  const files = [...new Set(context.files.map((file) => normalize(file)))];
  const comparisons = buildComparisons(context.repoRoot, context.baseRef, files);
  return mapPool(files, CONCURRENCY, async (file) => {
    const prepared = comparisons.get(file)!;
    if (!prepared.ok) {
      return { file, verdict: 'warn', cached: false, violations: [], note: prepared.note } satisfies FileVerdict;
    }
    const comparison = prepared.comparison;
    const key = cacheKey(comparison, rule, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as FileVerdict | undefined;
    if (hit) return { ...hit, file, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(comparison), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(comparison, result);
    if (cacheable) context.cache.set(key, verdict);
    return verdict;
  });
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export const check: Check = {
  name: 'context-footprint',
  tier: 'T1',
  run,
  selfTest,
};
