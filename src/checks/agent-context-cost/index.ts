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
  discoverInstructionCorpus,
  resolveInstructionSession,
  DEFAULT_ESTIMATOR_ID,
  type InstructionCorpus,
  type InstructionFile,
  type SessionLoadSet,
  type SessionProfileId,
} from '../../corpora/instructions/index.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA, type AgentContextCostVerdict, type LoadSetSummary } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { selfTest } from './self-test.ts';
import { defaultEstimator } from '../../corpora/instructions/index.ts';

/** Every semantic input to the judgment: content, delivered fragments,
 * normalized bindings, estimator identity, prompt, provider, model. Load-set
 * totals and unrelated cascade members are decoration, not key components —
 * they cannot re-bill a source (check design, cache). */
function cacheKey(source: InstructionFile, provider: string, model: string): string {
  const fragments = source.bindings.map((b) => [b.charged.kind, b.activation, b.charged.text]);
  const bindings = source.bindings.map((b) => [b.tool, b.profile, b.convention, JSON.stringify(b.scope), b.activation, b.semantics.status]);
  return VerdictCache.key([PROMPT_VERSION, source.content, JSON.stringify(fragments), JSON.stringify(bindings), DEFAULT_ESTIMATOR_ID, provider, model]);
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

/** One load-set class per (profile, instruction-directory CWD): the
 * deterministic session classes of this corpus (library design — never an
 * enumeration of arbitrary trigger combinations). */
interface LoadSetClass {
  id: string;
  profile: SessionProfileId;
  cwd: string;
  set: SessionLoadSet;
}

function loadSetClasses(corpus: InstructionCorpus): LoadSetClass[] {
  const repoFiles = corpus.files.filter((file) => file.origin === 'repo');
  const cwds = [...new Set(repoFiles.map((file) => dirOf(file.path)))].sort();
  const classes: LoadSetClass[] = [];
  for (const profile of corpus.profiles) {
    for (const cwd of cwds) {
      classes.push({
        id: `${profile}@${cwd === '' ? '.' : cwd}`,
        profile,
        cwd,
        set: resolveInstructionSession(corpus, { profile, cwd }),
      });
    }
  }
  return classes;
}

function members(cls: LoadSetClass): Set<string> {
  return new Set([
    ...cls.set.contributions.map((entry) => entry.locator),
    ...cls.set.possibleAdditional.map((entry) => entry.locator),
  ]);
}

function summarize(cls: LoadSetClass): LoadSetSummary {
  return {
    id: cls.id,
    baselineTokens: cls.set.confirmedTokens.count,
    conditionalTokens: cls.set.possibleAdditional.reduce((sum, entry) => sum + entry.charged.count, 0),
    complete: cls.set.complete,
  };
}

/** Union of instruction sources selected by the target paths: each target
 * resolves to the load-set classes at or beneath it (a file target uses its
 * directory's class); a target that is itself a source is judged directly. */
function selectSources(corpus: InstructionCorpus, classes: LoadSetClass[], repoRoot: string, targets: string[]): InstructionFile[] {
  const selected = new Set<string>();
  const byPath = new Map(corpus.files.filter((file) => file.origin === 'repo').map((file) => [file.path, file]));
  for (const target of targets) {
    const path = target === '.' ? '' : target;
    const direct = byPath.get(path);
    if (direct) selected.add(direct.locator);
    const dir = path === '' || isDirectory(join(repoRoot, path)) ? path : dirOf(path);
    const under = classes.filter((cls) => dir === '' || cls.cwd === dir || cls.cwd.startsWith(`${dir}/`));
    // A directory with no instruction files beneath it still belongs to the
    // classes of its ancestors; fall back to the nearest ancestor class.
    const applicable = under.length > 0 ? under : classes.filter((cls) => dir === cls.cwd || dir.startsWith(cls.cwd === '' ? '' : `${cls.cwd}/`));
    for (const cls of applicable) for (const locator of members(cls)) selected.add(locator);
  }
  return corpus.files.filter((file) => selected.has(file.locator));
}

async function run(context: CheckContext): Promise<AgentContextCostVerdict[]> {
  const targets = [...new Set(context.files.map(toPosix))];
  if (targets.length === 0) return [];
  const corpus = await discoverInstructionCorpus({ repoRoot: context.repoRoot });
  const classes = loadSetClasses(corpus);
  const system = systemPrompt();
  const sources = selectSources(corpus, classes, context.repoRoot, targets);
  const encoder = new TextEncoder();
  return mapPool(sources, CONCURRENCY, async (source) => {
    const containing = classes.filter((cls) => members(cls).has(source.locator));
    const sets = containing.map(summarize);
    const decorate = (verdict: AgentContextCostVerdict): AgentContextCostVerdict => ({
      ...verdict,
      sourceId: source.locator,
      estimatedTokens: source.fullFile.count,
      bytes: encoder.encode(source.content).length,
      bindings: source.bindings.map((b) => ({ tool: b.tool, profile: b.profile, convention: b.convention, activation: b.activation, semantics: b.semantics.status })),
      loadSets: sets,
    });
    if (source.bindings.every((b) => b.semantics.status !== 'verified')) {
      // No verified load semantics — a judgment could not say what the file
      // costs, so no spend: mechanical warn, retried when semantics land.
      const first = source.bindings[0];
      const reason = first !== undefined && first.semantics.status !== 'verified' ? first.semantics.reason : 'no bindings';
      return decorate({ file: source.path, verdict: 'warn', cached: false, violations: [], note: `semantics unverified — not judged: ${reason}` });
    }
    const key = cacheKey(source, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as AgentContextCostVerdict | undefined;
    if (hit) return decorate({ ...hit, file: source.path, cached: true });
    const result = await context.client.judge({ system, user: userPrompt(source, sets, encoder.encode(source.content).length), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(source, result, defaultEstimator);
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
