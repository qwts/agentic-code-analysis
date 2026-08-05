// The agent-rule-conflict check: state-shaped whole-corpus judgment of
// instruction contradictions (docs/design/check-agent-rule-conflict.md).
// Targets trigger, never truncate — the evidence is always the complete
// current corpus; repo sources matching the config exclude globs are dropped
// from the projection (fixture trees). One judge call when the artifact
// fits; deterministic bounded partitions otherwise; per-partition caching.
import type { Check, CheckContext } from '../registry.ts';
import { loadConfig } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { defaultEstimator, discoverInstructionCorpus } from '../../corpora/instructions/index.ts';
import { buildArtifact, serializePayload, slice, type ConflictArtifact } from './artifact.ts';
import { ASSESSMENTS, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, verdictSchema } from './judge-io.ts';
import { PLAN_VERSION, planPartitions, type Partition } from './partition.ts';
import { CORPUS_ROW, POLICY_VERSION, toVerdicts, validatePartition, type ConflictVerdict, type PartitionOutcome, type PartitionResult } from './outcome.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { selfTest } from './self-test.ts';

/** The cache surface this check needs; the self-test substitutes a no-op so
 * calibration stays live (ACA-0012). */
export interface OutcomeCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

function cacheKey(partition: Partition, payload: string, estimator: string, client: JudgeClient): string {
  return VerdictCache.key([PROMPT_VERSION, PLAN_VERSION, POLICY_VERSION, partition.kind, payload, estimator, client.provider, client.model]);
}

/** Guard for cache reads: a corrupted entry must re-judge, never crash. */
function isOutcome(value: unknown): value is PartitionOutcome {
  const outcome = value as PartitionOutcome;
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    (ASSESSMENTS as readonly string[]).includes(outcome.assessment) &&
    typeof outcome.note === 'string' &&
    Array.isArray(outcome.conflicts)
  );
}

/** The production path, shared verbatim by the self-test: project →
 * partition → judge → host policy. */
export async function judgeCorpus(
  repoRoot: string,
  client: JudgeClient,
  cache: OutcomeCache,
  excludeGlobs: readonly string[],
): Promise<ConflictVerdict[]> {
  const corpus = await discoverInstructionCorpus({ repoRoot });
  const artifact = buildArtifact(corpus, excludeGlobs);
  if (artifact.sources.length === 0) {
    return [{ file: CORPUS_ROW, verdict: 'pass', cached: false, violations: [], note: 'no instruction corpus', partitions: [], excludedSources: [...artifact.excluded] }];
  }
  const encoder = new TextEncoder();
  const payloadOf = (sourceIds: readonly string[], sessionIds: readonly string[]): string => {
    const { sources, sessions } = slice(artifact, sourceIds, sessionIds);
    return serializePayload(sources, sessions, artifact.estimator);
  };
  const partitions = planPartitions(artifact, (sourceIds, sessionIds) => {
    const payload = payloadOf(sourceIds, sessionIds);
    return { tokens: defaultEstimator.estimate(payload), bytes: encoder.encode(payload).length };
  });
  const system = systemPrompt();
  const results = await mapPool(partitions, CONCURRENCY, async (partition): Promise<PartitionResult> => {
    if (!partition.fits) {
      return { partition, status: 'skipped-oversize', note: `~${partition.estimatedTokens} tokens / ${partition.bytes} bytes exceed the pinned bound` };
    }
    const payload = payloadOf(partition.sourceIds, partition.sessionIds);
    const key = cacheKey(partition, payload, artifact.estimator, client);
    const hit = cache.get(key);
    if (isOutcome(hit)) return { partition, status: 'cached', outcome: hit };
    const result = await client.judge({ system, user: userPrompt(payload), schema: verdictSchema(partition.sourceIds), maxTokens: MAX_TOKENS });
    const sources = new Map(
      slice(artifact, partition.sourceIds, partition.sessionIds).sources.map((s) => [s.id, { path: s.path, content: s.content }]),
    );
    const validated = validatePartition(result, sources);
    if (!validated.ok) return { partition, status: 'degraded', note: validated.note };
    // Valid results — pass, fail, and judged uncertainty — are cacheable;
    // degradation and incomplete coverage never are (check design).
    cache.set(key, validated.outcome);
    return { partition, status: 'judged', outcome: validated.outcome };
  });
  return toVerdicts(results, artifact);
}

async function run(context: CheckContext): Promise<ConflictVerdict[]> {
  // State-shaped trigger semantics: any non-empty target set runs the
  // whole-corpus judgment; targets never narrow the evidence.
  if (context.files.length === 0) return [];
  const config = loadConfig(context.repoRoot);
  return judgeCorpus(context.repoRoot, context.client, context.cache, config.exclude);
}

export const check: Check = {
  name: 'agent-rule-conflict',
  tier: 'T1',
  run,
  selfTest,
};

export type { ConflictArtifact };
