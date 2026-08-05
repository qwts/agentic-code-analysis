// The comparison model of this check (ACA-0013): every judged file is either
// `new` (head snapshot only) or `legacy` (base and head snapshots), resolved
// against the merge-base once per run with rename detection. The judge sees
// snapshots carrying seam evidence; git stays in this module. Unlike
// context-footprint, no reverse import graph is needed — seam evidence is
// outbound-only — so no repo-wide read happens here.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../core/config.ts';
import { ambientCandidates, dependenciesOf } from './evidence.ts';

export interface Snapshot {
  path: string;
  content: string;
  dependencies: string[];
  candidates: string[];
}

export type Comparison =
  | { kind: 'new'; head: Snapshot }
  | { kind: 'legacy'; base: Snapshot; head: Snapshot };

/** Unavailable evidence (unreadable head, missing base snapshot for a file
 * the diff says changed) is a per-file degradation, never inferred as "new"
 * and never cached. */
export type Prepared = { ok: true; comparison: Comparison } | { ok: false; note: string };

interface ChangeStatus {
  added: Set<string>;
  modified: Set<string>;
  /** head path → base path, for renames. A copy/extraction stays `new`. */
  renamedFrom: Map<string, string>;
}

function git(repoRoot: string, args: string[]): string {
  // stderr piped, not inherited: findings-only output (D4) must not carry
  // git's noise.
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `-z --name-status` entries: STATUS␀path␀ for A/M/D/T, STATUS␀old␀new␀ for R. */
function changeStatus(repoRoot: string, mergeBase: string): ChangeStatus {
  const status: ChangeStatus = { added: new Set(), modified: new Set(), renamedFrom: new Map() };
  const tokens = git(repoRoot, ['diff', '--name-status', '-z', '--find-renames', mergeBase]).split('\0');
  for (let i = 0; i < tokens.length - 1; ) {
    const code = tokens[i]![0];
    if (code === 'R') {
      status.renamedFrom.set(tokens[i + 2]!, tokens[i + 1]!);
      i += 3;
    } else {
      const path = tokens[i + 1]!;
      if (code === 'A') status.added.add(path);
      else if (code !== 'D') status.modified.add(path);
      i += 2;
    }
  }
  return status;
}

export function snapshotOf(path: string, content: string): Snapshot {
  return { path, content, dependencies: dependenciesOf(path, content), candidates: ambientCandidates(content) };
}

/**
 * One merge-base resolution and one rename-aware diff per run. Per file: the
 * head content comes from disk; the base content from `git show` only when
 * the file changed or its base-tree membership must be probed (a path absent
 * from the diff is either unchanged-tracked — base equals head — or
 * untracked/new; one probe distinguishes them definitively).
 */
export function buildComparisons(repoRoot: string, baseRef: string, files: string[]): Map<string, Prepared> {
  let mergeBase: string;
  try {
    mergeBase = git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    // Run-level configuration error, never per-file "new" (ACA-0013).
    throw new ConfigError(`cannot resolve merge-base of ${baseRef} and HEAD; fetch the base ref or pass --base`);
  }
  const status = changeStatus(repoRoot, mergeBase);
  const showBase = (path: string): string | undefined => {
    try {
      return git(repoRoot, ['show', `${mergeBase}:${path}`]);
    } catch {
      return undefined;
    }
  };

  const prepared = new Map<string, Prepared>();
  for (const file of files) {
    let headContent: string;
    try {
      headContent = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      prepared.set(file, { ok: false, note: 'unreadable' });
      continue;
    }
    const head = snapshotOf(file, headContent);
    if (status.added.has(file)) {
      prepared.set(file, { ok: true, comparison: { kind: 'new', head } });
      continue;
    }
    const basePath = status.renamedFrom.get(file) ?? file;
    const changed = status.modified.has(basePath) || status.renamedFrom.has(file);
    const baseContent = showBase(basePath);
    if (baseContent === undefined) {
      // The diff says this path changed against the base, so its base blob
      // must exist; failing to read it is degraded evidence. A path the diff
      // never mentioned simply has no base version: genuinely new.
      prepared.set(file, changed ? { ok: false, note: 'base snapshot unavailable' } : { ok: true, comparison: { kind: 'new', head } });
      continue;
    }
    prepared.set(file, { ok: true, comparison: { kind: 'legacy', base: snapshotOf(basePath, baseContent), head } });
  }
  return prepared;
}
