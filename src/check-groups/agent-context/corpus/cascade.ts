// Session-load-set construction and target resolution: per tool, one
// equivalence class per directory where its instruction scope changes;
// entries ordered root→leaf; totals split into baseline (verified always),
// conditional (path/model-selected/unknown — potential, never claimed
// paid), and manual. Identity moves with membership/order/activation, never
// with filesystem enumeration order (design doc, session load sets).
import { byCodeUnit, type InstructionCorpus, type InstructionSource, type LoadEntry, type SessionLoadSet, type Tool } from './model.ts';

interface BoundSource {
  source: InstructionSource;
  binding: InstructionSource['bindings'][number];
}

export function buildLoadSets(sources: InstructionSource[]): SessionLoadSet[] {
  const byTool = new Map<Tool, BoundSource[]>();
  for (const source of sources) {
    for (const binding of source.bindings) {
      const list = byTool.get(binding.tool) ?? [];
      list.push({ source, binding });
      byTool.set(binding.tool, list);
    }
  }
  const sets: SessionLoadSet[] = [];
  for (const [tool, bound] of [...byTool.entries()].sort(([a], [b]) => byCodeUnit(a, b))) {
    const classDirs = [...new Set(bound.map(({ binding }) => binding.scopeDir))].sort();
    if (!classDirs.includes('')) classDirs.unshift('');
    for (const dir of classDirs) {
      const members = bound
        .filter(({ binding }) => inScope(binding.scopeDir, dir))
        .sort((a, b) => depth(a.binding.scopeDir) - depth(b.binding.scopeDir) || byCodeUnit(a.source.path, b.source.path));
      if (members.length === 0) continue;
      sets.push(loadSet(tool, dir, members));
    }
  }
  return sets;
}

function inScope(scopeDir: string, targetDir: string): boolean {
  return scopeDir === '' || scopeDir === targetDir || targetDir.startsWith(scopeDir + '/');
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

function loadSet(tool: Tool, targetDir: string, members: BoundSource[]): SessionLoadSet {
  const entries: LoadEntry[] = [];
  let baseline = 0;
  let conditional = 0;
  let manual = 0;
  let complete = true;
  for (const { source, binding } of members) {
    const verified = binding.semantics.status === 'verified';
    if (!verified) complete = false;
    let tokens = 0;
    for (const fragment of binding.fragments) {
      tokens += fragment.estimate.tokens;
      if (!verified || fragment.activation === 'path' || fragment.activation === 'model-selected' || fragment.activation === 'unknown') {
        conditional += fragment.estimate.tokens;
      } else if (fragment.activation === 'manual') {
        manual += fragment.estimate.tokens;
      } else {
        baseline += fragment.estimate.tokens;
      }
    }
    entries.push({ sourceId: source.id, activation: binding.activation, tokens, verified });
  }
  return {
    id: `${tool}:${targetDir === '' ? '.' : targetDir}`,
    tool,
    targetDir,
    entries,
    baselineTokens: baseline,
    conditionalTokens: conditional,
    manualTokens: manual,
    complete,
  };
}

/** The load sets a session working in `dir` pays: per tool, the deepest
 * class at or above `dir`. */
export function loadSetsForDir(corpus: InstructionCorpus, dir: string): SessionLoadSet[] {
  const best = new Map<Tool, SessionLoadSet>();
  for (const set of corpus.loadSets) {
    if (!inScope(set.targetDir, dir)) continue;
    const current = best.get(set.tool);
    if (current === undefined || depth(set.targetDir) > depth(current.targetDir)) best.set(set.tool, set);
  }
  return [...best.values()].sort((a, b) => byCodeUnit(a.id, b.id));
}

/** Every distinct load set beneath `dir`, plus the classes that apply to
 * files directly in it — `''` is the full-corpus selection. */
export function loadSetsUnder(corpus: InstructionCorpus, dir: string): SessionLoadSet[] {
  const within = corpus.loadSets.filter((set) => dir === '' || set.targetDir === dir || set.targetDir.startsWith(dir + '/'));
  const merged = new Map<string, SessionLoadSet>();
  for (const set of [...within, ...loadSetsForDir(corpus, dir)]) merged.set(set.id, set);
  return [...merged.values()].sort((a, b) => byCodeUnit(a.id, b.id));
}
