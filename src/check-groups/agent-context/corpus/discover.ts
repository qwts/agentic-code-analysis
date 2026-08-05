// Corpus assembly: one bounded snapshot per authorized root, every
// convention adapter over each snapshot in stable order, candidates merged
// by physical identity — one InstructionSource per file, however many tool
// bindings it carries — then load sets derived. Deterministic output:
// sorted sources, sorted bindings, stable ids. The library never calls
// homedir() and reads only the roots it was handed (design doc, discovery
// and safety).
import { createHash } from 'node:crypto';
import { agentsConvention } from './conventions/agents.ts';
import { claudeConvention } from './conventions/claude.ts';
import { copilotConvention } from './conventions/copilot.ts';
import { cursorConvention } from './conventions/cursor.ts';
import { skillsConvention } from './conventions/skills.ts';
import { windsurfConvention } from './conventions/windsurf.ts';
import { buildLoadSets } from './cascade.ts';
import type { InstructionConvention } from './adapter.ts';
import { byCodeUnit, sourceId, type InstructionCorpus, type InstructionSource, type Origin, type ToolBinding } from './model.ts';
import { referenceEstimator, type TokenEstimator } from './tokens.ts';
import { walkTree, type TreeSnapshot } from './tree.ts';

export interface UserRoot {
  label: string;
  /** Filesystem path; ignored when a snapshot is injected. */
  path?: string;
  snapshot?: TreeSnapshot;
}

export interface CorpusRequest {
  repoRoot: string;
  /** Explicitly authorized user-global roots (e.g. a chosen ~/.claude). */
  userRoots?: UserRoot[];
  /** Injections for tests; production uses walkTree + heuristic-v1. */
  repoSnapshot?: TreeSnapshot;
  estimator?: TokenEstimator;
}

const CONVENTIONS: readonly InstructionConvention[] = [
  agentsConvention,
  claudeConvention,
  skillsConvention,
  copilotConvention,
  cursorConvention,
  windsurfConvention,
];

export function buildInstructionCorpus(request: CorpusRequest): InstructionCorpus {
  const estimator = request.estimator ?? referenceEstimator;
  const estimate = (text: string) => estimator.estimate(text);
  const diagnostics: string[] = [];
  const sources = new Map<string, InstructionSource>();

  const roots: { origin: Origin; label: string; snapshot: TreeSnapshot }[] = [
    { origin: 'repository', label: 'repo', snapshot: request.repoSnapshot ?? walkTree(request.repoRoot) },
  ];
  for (const userRoot of request.userRoots ?? []) {
    const snapshot = userRoot.snapshot ?? (userRoot.path !== undefined ? walkTree(userRoot.path) : undefined);
    if (snapshot === undefined) {
      diagnostics.push(`user root "${userRoot.label}" has neither path nor snapshot`);
      continue;
    }
    roots.push({ origin: 'user', label: userRoot.label, snapshot });
  }

  for (const root of roots) {
    for (const convention of CONVENTIONS) {
      for (const candidate of convention.discover(root.snapshot, root.origin, estimate)) {
        const content = root.snapshot.content(candidate.path);
        if (content === undefined) continue;
        const id = sourceId(root.origin, root.label, candidate.path);
        let source = sources.get(id);
        if (source === undefined) {
          source = {
            id,
            origin: root.origin,
            path: candidate.path,
            content,
            sha256: createHash('sha256').update(content).digest('hex'),
            estimate: estimate(content),
            bindings: [],
            diagnostics: [],
          };
          sources.set(id, source);
        }
        source.bindings.push(candidate.binding);
        if (candidate.diagnostics) source.diagnostics.push(...candidate.diagnostics);
      }
    }
    // Walk diagnostics surface once per root, after all reads happened.
    diagnostics.push(...root.snapshot.diagnostics.map((d) => `${root.label}: ${d}`));
  }

  const sorted = [...sources.values()].sort((a, b) => byCodeUnit(a.id, b.id));
  for (const source of sorted) source.bindings.sort(bindingOrder);
  return { sources: sorted, loadSets: buildLoadSets(sorted), diagnostics, estimator: estimator.id };
}

function bindingOrder(a: ToolBinding, b: ToolBinding): number {
  return byCodeUnit(a.tool, b.tool) || byCodeUnit(a.convention, b.convention) || byCodeUnit(a.scopeDir, b.scopeDir);
}
