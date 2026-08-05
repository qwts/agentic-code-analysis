// The check-local, merge-base-aware change index (check design, "Change
// index") — the only doc-drift module that runs Git. It exists because the
// shared selector intentionally omits deletions while `referent-gone`
// requires them: one rename-aware diff yields added/modified/deleted state
// and both sides of every rename, with base text read only so references to
// disappeared names can still match.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../core/config.ts';

export type ReferentStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'seeded';

export interface Referent {
  path: string;
  status: ReferentStatus;
  /** Head path when `path` is the renamed-away side. */
  renamedTo?: string;
  /** Current content; absent for deleted, and for unreadable-but-present. */
  head?: string;
  /** Merge-base content, for matching tokens that disappeared. */
  base?: string;
  /** Present but unreadable — insufficient evidence, never "deleted". */
  unreadable?: boolean;
}

/** Referenced path → referent. Renames appear under both sides: the old
 * path as `renamed` (a doc naming it has a gone referent), the new path as
 * `modified`. */
export type ChangeIndex = Map<string, Referent>;

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Tracked paths, repo-relative. The doc corpus is tracked documentation
 * (check design): an untracked or generated Markdown file under an in-scope
 * glob must never bill a judge call or fail a run (Codex review, PR #41). */
export function trackedFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function readHead(repoRoot: string, path: string): Pick<Referent, 'head' | 'unreadable'> {
  try {
    return { head: readFileSync(join(repoRoot, path), 'utf8') };
  } catch {
    return { unreadable: true };
  }
}

/**
 * @param seeds Changed-referent seed paths from `CheckContext.files` —
 *   already global-scope-filtered by the dispatcher (or explicit CLI paths,
 *   which mean "treat as changed" for local iteration).
 * @param inScope The repo's global include/exclude filter, applied to the
 *   deleted and renamed-away paths this index contributes itself — they
 *   never passed through the dispatcher.
 */
export function buildChangeIndex(
  repoRoot: string,
  baseRef: string,
  seeds: string[],
  inScope: (paths: string[]) => string[],
): ChangeIndex {
  let mergeBase: string;
  try {
    mergeBase = git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    throw new ConfigError(`cannot resolve merge-base of ${baseRef} and HEAD; fetch the base ref or pass --base`);
  }
  const showBase = (path: string): string | undefined => {
    try {
      return git(repoRoot, ['show', `${mergeBase}:${path}`]);
    } catch {
      return undefined;
    }
  };

  // Seeds are the only source of added/modified referents (the dispatcher
  // already scoped them; explicit paths bypass selection deliberately). The
  // index itself contributes only the gone side — scope-filtered deletions
  // and renamed-away paths — which the shared selector cannot supply.
  const diffed = new Map<string, Referent>();
  const gone: Referent[] = [];
  const tokens = git(repoRoot, ['diff', '--name-status', '-z', '--find-renames', mergeBase]).split('\0');
  for (let i = 0; i < tokens.length - 1; ) {
    const code = tokens[i]![0];
    if (code === 'R') {
      const [oldPath, newPath] = [tokens[i + 1]!, tokens[i + 2]!];
      const head = readHead(repoRoot, newPath);
      gone.push({ path: oldPath, status: 'renamed', renamedTo: newPath, base: showBase(oldPath), ...head });
      diffed.set(newPath, { path: newPath, status: 'modified', base: showBase(oldPath), ...head });
      i += 3;
      continue;
    }
    const path = tokens[i + 1]!;
    if (code === 'A') diffed.set(path, { path, status: 'added', ...readHead(repoRoot, path) });
    else if (code === 'D') gone.push({ path, status: 'deleted', base: showBase(path) });
    else diffed.set(path, { path, status: 'modified', base: showBase(path), ...readHead(repoRoot, path) });
    i += 2;
  }
  const index: ChangeIndex = new Map();
  const goneInScope = new Set(inScope(gone.map((referent) => referent.path)));
  for (const referent of gone) {
    if (goneInScope.has(referent.path)) index.set(referent.path, referent);
  }
  for (const seed of seeds) {
    // A seed that is itself a gone path keeps its diff-derived entry — a
    // deleted file must never degrade to an unreadable "seeded" one.
    if (index.has(seed)) continue;
    index.set(seed, diffed.get(seed) ?? { path: seed, status: 'seeded', ...readHead(repoRoot, seed) });
  }
  return index;
}
