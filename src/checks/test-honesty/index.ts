// The test-honesty check: orchestrates the rubric, per-file evidence, the
// verdict cache, and the judge (operational bounds per the check design:
// one test file per request, concurrency 3, max_tokens 4096). Semantics are
// absolute head-state — deliberately not ACA-0013's comparative model.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA } from './judge-io.ts';
import { scopeTestFiles, testFileGlobs } from './scope.ts';
import { buildEvidence, type Evidence } from './unit-context.ts';
import { selfTest } from './self-test.ts';

const CONCURRENCY = 3;

/**
 * Every semantic input to the judgment (ACA-0003 D7): prompt version, the
 * test's identity and content, the companion context exactly as sent (units,
 * snapshots, unavailable markers), rubric, provider, model. Scope globs and
 * base-ref identity select work rather than change the judgment and stay out
 * of the key.
 */
function cacheKey(evidence: Evidence, rubric: string, provider: string, model: string): string {
  return VerdictCache.key([
    PROMPT_VERSION,
    evidence.file,
    evidence.content,
    evidence.mode,
    JSON.stringify(evidence.units),
    JSON.stringify(evidence.snapshots),
    JSON.stringify(evidence.unavailable),
    rubric,
    provider,
    model,
  ]);
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);
  const globs = testFileGlobs(context.repoRoot);
  // Out-of-corpus files — changed or explicit — are dropped, not judged:
  // zero judge calls for non-test paths, and no placeholder verdicts.
  const files = scopeTestFiles(context.files, globs);
  return mapPool(files, CONCURRENCY, async (file) => {
    let content: string;
    try {
      content = readFileSync(join(context.repoRoot, file), 'utf8');
    } catch {
      return { file, verdict: 'warn', cached: false, violations: [], note: 'unreadable' } satisfies FileVerdict;
    }
    const evidence = buildEvidence(context.repoRoot, file, content, globs);
    const key = cacheKey(evidence, rubric, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as FileVerdict | undefined;
    if (hit) return { ...hit, file, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(evidence), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(evidence, result);
    if (cacheable) context.cache.set(key, verdict);
    return verdict;
  });
}

/** Bounded worker pool preserving input order (own copy — checks never
 * import each other, ACA-0003 D1). */
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
  name: 'test-honesty',
  tier: 'T1',
  run,
  selfTest,
};
