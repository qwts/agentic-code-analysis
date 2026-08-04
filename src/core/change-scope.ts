// Which files a check judges: changed files (working tree vs the merge-base
// with the base ref), filtered by the consuming repo's include/exclude globs.
// Explicit CLI paths bypass diff selection entirely (ACA-0004 D5 selects by
// change; this module only decides membership, never verdicts).
import { execFileSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
import type { AcaConfig } from './config.ts';

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

export function changedFiles(baseRef: string, cwd: string): string[] {
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], cwd);
  const out = git(['diff', '--name-only', '--diff-filter=d', mergeBase], cwd);
  return out === '' ? [] : out.split('\n');
}

export function filterScope(files: string[], config: Pick<AcaConfig, 'include' | 'exclude'>): string[] {
  return files.filter(
    (file) =>
      config.include.some((glob) => matchesGlob(file, glob)) &&
      !config.exclude.some((glob) => matchesGlob(file, glob)),
  );
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
