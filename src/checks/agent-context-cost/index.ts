// The agent-context-cost check: full-corpus discovery, target paths resolved
// to session load sets (ACA-0023 — targets select, evidence is the whole
// corpus), one judge request per unique instruction source, concurrency 3.
// Only the semantic judgment is cached; the mechanical frame (estimates,
// bindings, load-set memberships) decorates every verdict on every run.
import { statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Check, CheckContext } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import {
  buildInstructionCorpus,
  loadSetsForDir,
  loadSetsUnder,
  referenceEstimator,
  type InstructionCorpus,
  type InstructionSource,
} from '../../check-groups/agent-context/corpus/index.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA, type AgentContextCostVerdict } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { selfTest } from './self-test.ts';

/** Every semantic input to the judgment: content, delivered fragments,
 * normalized bindings, estimator identity, prompt, provider, model. Load-set
 * totals and unrelated cascade members are decoration, not key components —
 * they cannot re-bill a source (check design, cache). */
function cacheKey(source: InstructionSource, provider: string, model: string): string {
  const fragments = source.bindings.flatMap((b) => b.fragments.map((f) => [f.kind, f.activation, f.text]));
  const bindings = source.bindings.map((b) => [b.tool, b.convention, b.scopeDir, b.pathGlobs ?? [], b.activation, b.semantics.status]);
  return VerdictCache.key([PROMPT_VERSION, source.content, JSON.stringify(fragments), JSON.stringify(bindings), referenceEstimator.id, provider, model]);
}

const toPosix = (path: string): string => normalize(path).replaceAll('\\', '/').replace(/\/+$/, '');
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Union of instruction sources selected by the target paths: each target
 * resolves to its session load sets (a directory selects every class at or
 * beneath it); a target that is itself a source is judged directly. */
function selectSources(corpus: InstructionCorpus, repoRoot: string, targets: string[]): InstructionSource[] {
  const selected = new Set<string>();
  const byPath = new Map(corpus.sources.filter((s) => s.origin === 'repository').map((s) => [s.path, s]));
  for (const target of targets) {
    const path = target === '.' ? '' : target;
    const direct = byPath.get(path);
    if (direct) selected.add(direct.id);
    const sets = path === '' || isDirectory(join(repoRoot, path)) ? loadSetsUnder(corpus, path) : loadSetsForDir(corpus, dirOf(path));
    for (const set of sets) for (const entry of set.entries) selected.add(entry.sourceId);
  }
  return corpus.sources.filter((source) => selected.has(source.id));
}

async function run(context: CheckContext): Promise<AgentContextCostVerdict[]> {
  const targets = [...new Set(context.files.map(toPosix))];
  if (targets.length === 0) return [];
  const corpus = buildInstructionCorpus({ repoRoot: context.repoRoot });
  const system = systemPrompt();
  const sources = selectSources(corpus, context.repoRoot, targets);
  const membership = (id: string) =>
    corpus.loadSets.filter((set) => set.entries.some((entry) => entry.sourceId === id));
  return mapPool(sources, CONCURRENCY, async (source) => {
    const sets = membership(source.id);
    const decorate = (verdict: AgentContextCostVerdict): AgentContextCostVerdict => ({
      ...verdict,
      sourceId: source.id,
      estimatedTokens: source.estimate.tokens,
      bytes: source.estimate.bytes,
      bindings: source.bindings.map((b) => ({ tool: b.tool, convention: b.convention, activation: b.activation, semantics: b.semantics.status })),
      loadSets: sets.map((set) => ({ id: set.id, baselineTokens: set.baselineTokens, conditionalTokens: set.conditionalTokens })),
    });
    if (source.bindings.every((b) => b.semantics.status === 'unverified')) {
      // No verified load semantics — a judgment could not say what the file
      // costs, so no spend: mechanical warn, retried when semantics land.
      const reason = source.bindings[0]?.semantics.status === 'unverified' ? (source.bindings[0].semantics as { reason: string }).reason : 'no bindings';
      return decorate({ file: source.path, verdict: 'warn', cached: false, violations: [], note: `semantics unverified — not judged: ${reason}` });
    }
    const key = cacheKey(source, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as AgentContextCostVerdict | undefined;
    if (hit) return decorate({ ...hit, file: source.path, cached: true });
    const result = await context.client.judge({ system, user: userPrompt(source, sets), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(source, result, referenceEstimator);
    if (cacheable) context.cache.set(key, verdict);
    return decorate(verdict);
  });
}

export const check: Check = {
  name: 'agent-context-cost',
  tier: 'T1',
  run,
  selfTest,
};
