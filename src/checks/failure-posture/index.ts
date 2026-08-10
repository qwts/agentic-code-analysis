// The failure-posture check: orchestrates rubric text, per-file comparisons,
// the mechanical applicability prefilter, the verdict cache, and the judge
// (operational bounds per the check design: one file per request,
// concurrency 3, max_tokens 4096).
import { normalize } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { buildComparisons, type Comparison, type Snapshot } from './comparison.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA, type FailurePostureVerdict } from './judge-io.ts';
import { classifyFile, type SideSignals } from './prefilter.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { selfTest } from './self-test.ts';

/**
 * Pair-addressed key (ACA-0013 extending ACA-0003 D7): every semantic input
 * to the comparative judgment — kind, both snapshots' identity, content, and
 * import edges — plus rubric, prompt version, provider, model. Prefilter
 * hints are deterministic from the snapshots and add nothing; base ref/SHA,
 * growth, and line counts are excluded, so a moving merge-base cannot
 * re-bill an unchanged semantic pair.
 */
function cacheKey(comparison: Comparison, rubric: string, provider: string, model: string): string {
  const snapshot = (s: Snapshot): string[] => [s.path, s.content, JSON.stringify(s.imports), JSON.stringify(s.importedBy)];
  const base = comparison.kind === 'legacy' ? snapshot(comparison.base) : ['(no base)'];
  return VerdictCache.key([PROMPT_VERSION, String(MAX_TOKENS), comparison.kind, ...base, ...snapshot(comparison.head), rubric, provider, model]);
}

/** Both sides confidently irrelevant → skip without a judge call. A base
 * with signals still judges even when the head has none: a removed effect
 * is a direction of change the judge may call improved. */
function applicability(comparison: Comparison): { candidate: boolean; head: SideSignals; base?: SideSignals } {
  const head = classifyFile(comparison.head.path, comparison.head.content);
  if (comparison.kind === 'new') return { candidate: head.candidate, head };
  const base = classifyFile(comparison.base.path, comparison.base.content);
  return { candidate: head.candidate || base.candidate, head, base };
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);
  // Normalize so explicit ./src/x.ts matches the repo-relative graph and key;
  // dedupe so one path cannot race the pool and bill twice.
  const files = [...new Set(context.files.map((file) => normalize(file)))];
  const comparisons = buildComparisons(context.repoRoot, context.baseRef, files);
  return mapPool(files, CONCURRENCY, async (file) => {
    const prepared = comparisons.get(file)!;
    if (!prepared.ok) {
      return { file, verdict: 'warn', cached: false, violations: [], note: prepared.note } satisfies FileVerdict;
    }
    const comparison = prepared.comparison;
    const signals = applicability(comparison);
    if (!signals.candidate) {
      // Mechanical skip: no semantic judgment occurred, so it is never
      // cached and never rendered as a finding; --json carries `skipped`.
      return {
        file,
        verdict: 'pass',
        cached: false,
        violations: [],
        skipped: true,
        note: `skipped: ${signals.head.reason}`,
      } satisfies FailurePostureVerdict;
    }
    const key = cacheKey(comparison, rubric, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as FileVerdict | undefined;
    if (hit) return { ...hit, file, cached: true };
    const hints = { head: signals.head.hints, ...(signals.base ? { base: signals.base.hints } : {}) };
    const result = await context.client.judge({ system, user: userPrompt(comparison, hints), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(comparison, result);
    if (cacheable) context.cache.set(key, verdict);
    return verdict;
  });
}

export const check: Check = {
  name: 'failure-posture',
  tier: 'T1',
  run,
  selfTest,
};
