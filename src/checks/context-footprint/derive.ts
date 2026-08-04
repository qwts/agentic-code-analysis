// Static derivations for the per-file judge payload (check design, "Judge
// input"): import paths, imported-by paths, diff hunks, growth line. Paths
// only, never contents — they exist so the judge reasons about footprint
// instead of guessing from content alone.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export interface FileFacts {
  imports: string[];
  importedBy: string[];
  hunks: string;
  growth: string;
}

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function importSpecifiers(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) found.push(spec);
  }
  return found;
}

/** Relative specifiers resolve to repo-relative paths; bare ones stay as-is. */
export function resolveSpecifier(fromFile: string, spec: string): string {
  return spec.startsWith('.') ? normalize(join(dirname(fromFile), spec)) : spec;
}

function comparable(path: string): string {
  return path.replace(CODE_EXT, '');
}

export function importsOf(file: string, content: string): string[] {
  return [...new Set(importSpecifiers(content).map((spec) => resolveSpecifier(file, spec)))].sort();
}

export function importedBy(repoRoot: string, file: string, repoFiles: string[]): string[] {
  const target = comparable(file);
  const importers: string[] = [];
  for (const candidate of repoFiles) {
    if (candidate === file || !CODE_EXT.test(candidate)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, candidate), 'utf8');
    } catch {
      continue;
    }
    const hit = importSpecifiers(content).some(
      (spec) => comparable(resolveSpecifier(candidate, spec)) === target,
    );
    if (hit) importers.push(candidate);
  }
  return importers.sort();
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

export function repoFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files']).split('\n').filter(Boolean);
}

/** Diff hunks and the growth line for one file vs the merge-base of baseRef. */
export function changeFacts(repoRoot: string, baseRef: string, file: string, content: string): { hunks: string; growth: string } {
  const lines = content.split('\n').length;
  let base: string | undefined;
  try {
    base = git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    return { hunks: '', growth: `${lines} lines (no diff base)` };
  }
  let hunks = '';
  try {
    const diff = git(repoRoot, ['diff', base, '--', file]);
    hunks = diff.slice(diff.indexOf('@@'));
    if (!diff.includes('@@')) hunks = '';
  } catch {
    hunks = '';
  }
  try {
    const before = git(repoRoot, ['show', `${base}:${file}`]).split('\n').length;
    if (before === lines) return { hunks, growth: `unchanged at ${lines} lines` };
    return { hunks, growth: `${before < lines ? 'grew' : 'shrank'} from ${before} to ${lines} lines` };
  } catch {
    return { hunks, growth: `new file, ${lines} lines` };
  }
}
