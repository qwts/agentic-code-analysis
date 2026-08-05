// Whole-package skill information-architecture check. The instruction corpus
// supplies loading facts; this check selects packages, binds workload evidence,
// bounds one request per package, verifies proposals, and caches only validated
// judgments.
import { posix } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { defaultEstimator, DEFAULT_ESTIMATOR_ID, discoverInstructionCorpus } from '../../corpora/instructions/index.ts';
import { buildPayload, INPUT_CHAR_LIMIT, PAYLOAD_VERSION } from './payload.ts';
import { buildSkillPackages, selectSkillPackages } from './skill-topology.ts';
import { loadTaskEvidence, SIDECAR_PATH, TASK_EVIDENCE_VERSION } from './task-evidence.ts';
import {
  CONCURRENCY,
  MAX_TOKENS,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  systemPrompt,
  userPrompt,
  VERDICT_SCHEMA,
  VERIFIER_VERSION,
  type SkillInformationArchitectureVerdict,
} from './judge-io.ts';
import { judgeOutcome } from './outcome.ts';
import { RESOURCE_CLASSIFIER_VERSION } from './resource-kind.ts';
import { mapPool } from './pool.ts';
import { selfTest } from './self-test.ts';

function canonicalTarget(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  return normalized === '' ? '.' : posix.normalize(normalized);
}

function cacheKey(payload: string, provider: string, model: string): string {
  return VerdictCache.key([
    PROMPT_VERSION,
    SCHEMA_VERSION,
    VERIFIER_VERSION,
    PAYLOAD_VERSION,
    TASK_EVIDENCE_VERSION,
    RESOURCE_CLASSIFIER_VERSION,
    `${INPUT_CHAR_LIMIT}`,
    DEFAULT_ESTIMATOR_ID,
    payload,
    provider,
    model,
  ]);
}

function unsupportedTargets(targets: readonly string[], selected: readonly { packageDir: string; skillFile: string }[]): FileVerdict[] {
  return targets.flatMap((target) => {
    if (posix.basename(target) !== 'SKILL.md') return [];
    if (selected.some((pkg) => pkg.skillFile === target)) return [];
    return [{ file: target, verdict: 'warn' as const, cached: false, violations: [], note: 'target is not a corpus-bound repository skill package' }];
  });
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const targets = [...new Set(context.files.map(canonicalTarget))];
  if (targets.length === 0) return [];
  const corpus = await discoverInstructionCorpus({ repoRoot: context.repoRoot });
  const packages = buildSkillPackages(corpus);
  const selected = selectSkillPackages(packages, targets, SIDECAR_PATH);
  const evidence = loadTaskEvidence(context.repoRoot, selected);
  const system = systemPrompt();
  const verdicts = await mapPool(selected, CONCURRENCY, async (pkg): Promise<SkillInformationArchitectureVerdict> => {
    const tasks = evidence.get(pkg.packageId)!;
    const payload = buildPayload(pkg, tasks);
    if (payload.text.length > INPUT_CHAR_LIMIT) {
      return {
        file: pkg.skillFile,
        verdict: 'warn',
        cached: false,
        violations: [],
        basis: tasks.basis,
        packageId: pkg.packageId,
        packageDir: pkg.packageDir,
        omissions: payload.omissions,
        note: `root package frame exceeds ${INPUT_CHAR_LIMIT} character input bound — not judged`,
      };
    }
    const key = cacheKey(payload.text, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as SkillInformationArchitectureVerdict | undefined;
    if (hit !== undefined) return { ...hit, file: pkg.skillFile, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(payload), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const outcome = judgeOutcome(pkg, tasks, payload, result, defaultEstimator);
    if (outcome.cacheable) context.cache.set(key, outcome.verdict);
    return outcome.verdict;
  });
  return [...unsupportedTargets(targets, selected), ...verdicts];
}

export const check: Check = {
  name: 'skill-information-architecture',
  tier: 'T1',
  run,
  selfTest,
};
