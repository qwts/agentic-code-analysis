// The context-footprint check: orchestrates rule text, per-file facts, the
// verdict cache, and the judge (operational bounds per the check design: one
// file per request, concurrency 3, max_tokens 4096).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { changeFacts, importedBy, importsOf, repoFiles, type FileFacts } from './derive.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from './judge-io.ts';
import { selfTest } from './self-test.ts';

const CONCURRENCY = 3;

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rule = ruleText();
  const system = systemPrompt(rule);
  const all = repoFiles(context.repoRoot);
  return mapPool(context.files, CONCURRENCY, async (file) => {
    let content: string;
    try {
      content = readFileSync(join(context.repoRoot, file), 'utf8');
    } catch {
      return { file, verdict: 'warn', cached: false, violations: [], note: 'unreadable' } satisfies FileVerdict;
    }
    const facts: FileFacts = {
      imports: importsOf(file, content),
      importedBy: importedBy(context.repoRoot, file, all),
      ...changeFacts(context.repoRoot, context.baseRef, file, content),
    };
    // Key per ACA-0003 D7: hunks and growth are orientation, not semantic
    // state — deliberately excluded so a moving merge-base cannot re-bill.
    const key = VerdictCache.key([content, JSON.stringify(facts.imports), JSON.stringify(facts.importedBy), rule, PROMPT_VERSION, context.client.provider, context.client.model]);
    const hit = context.cache.get(key) as FileVerdict | undefined;
    if (hit) return { ...hit, file, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(file, content, facts), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(file, result);
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
