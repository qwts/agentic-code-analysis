// The seam-audit check: orchestrates the rubric, per-file comparisons, the
// mechanical leaf prefilter, the verdict cache, and the judge (operational
// bounds per the check design: one file per request, concurrency 3,
// max_tokens 4096). Judgment is spent only where there is something to judge:
// a mechanically proven leaf never reaches the cache or the client.
// POSIX normalize: CLI paths must match repo-relative git paths ('/' on
// every platform) for comparison lookup and cache identity (Copilot, PR #34).
import { normalize } from 'node:path/posix';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { buildComparisons, type Comparison, type Snapshot } from './comparison.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA, type SeamAuditVerdict } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { provenLeaf } from './prefilter.ts';
import { selfTest } from './self-test.ts';

/**
 * Pair-addressed key (ACA-0013 pattern): every semantic input to the
 * comparative judgment — kind, both snapshots' identity, content, and
 * extracted evidence — plus rubric, prompt version, provider, model. Base
 * ref/SHA and derivable orientation are excluded, so a moving merge-base
 * cannot re-bill an unchanged semantic pair.
 */
function cacheKey(comparison: Comparison, rubric: string, provider: string, model: string): string {
  const snapshot = (s: Snapshot): string[] => [s.path, s.content, JSON.stringify(s.dependencies), JSON.stringify(s.candidates)];
  const base = comparison.kind === 'legacy' ? snapshot(comparison.base) : ['(no base)'];
  return VerdictCache.key([PROMPT_VERSION, String(MAX_TOKENS), comparison.kind, ...base, ...snapshot(comparison.head), rubric, provider, model]);
}

/** The zero-call path: recomputed every run, never cached, observable in
 * --json via source/testabilityFootprint. New + proven-leaf head is
 * mechanically compliant; legacy with both ends proven leaf mechanically
 * held. A leaf on one end only still needs judgment. */
function mechanicalVerdict(comparison: Comparison): SeamAuditVerdict | undefined {
  const shared = {
    file: comparison.head.path,
    verdict: 'pass',
    cached: false,
    violations: [],
    residualViolations: [],
    testabilityFootprint: [],
    source: 'mechanical-prefilter',
  } satisfies Partial<SeamAuditVerdict> & FileVerdict;
  if (comparison.kind === 'new') {
    return provenLeaf(comparison.head.content) ? { ...shared, assessment: 'new-compliant' } : undefined;
  }
  if (!provenLeaf(comparison.base.content) || !provenLeaf(comparison.head.content)) return undefined;
  return {
    ...shared,
    assessment: 'held',
    ...(comparison.base.path !== comparison.head.path ? { basePath: comparison.base.path } : {}),
  };
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);
  // Normalize so explicit ./src/x.ts matches the repo-relative key; dedupe so
  // one path cannot race the pool and bill twice.
  const files = [...new Set(context.files.map((file) => normalize(file)))];
  const comparisons = buildComparisons(context.repoRoot, context.baseRef, files);
  return mapPool(files, CONCURRENCY, async (file) => {
    const prepared = comparisons.get(file)!;
    if (!prepared.ok) {
      return { file, verdict: 'warn', cached: false, violations: [], note: prepared.note } satisfies FileVerdict;
    }
    const comparison = prepared.comparison;
    const mechanical = mechanicalVerdict(comparison);
    if (mechanical) return mechanical;
    const key = cacheKey(comparison, rubric, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as FileVerdict | undefined;
    if (hit) return { ...hit, file, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(comparison), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(comparison, result);
    if (cacheable) context.cache.set(key, verdict);
    return verdict;
  });
}

export const check: Check = {
  name: 'seam-audit',
  tier: 'T1',
  run,
  selfTest,
};
