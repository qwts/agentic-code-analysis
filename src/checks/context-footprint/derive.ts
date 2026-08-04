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

/**
 * One pass over the repo builds the reverse import graph; per-file lookups
 * are then O(1). Scanning per changed file instead would be
 * O(changed × repo) sync I/O (review finding, PR #8).
 */
export function buildImporterIndex(repoRoot: string, repoFiles: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const candidate of repoFiles) {
    if (!CODE_EXT.test(candidate)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, candidate), 'utf8');
    } catch {
      continue;
    }
    for (const spec of new Set(importSpecifiers(content))) {
      const resolved = comparable(resolveSpecifier(candidate, spec));
      const importers = index.get(resolved) ?? [];
      importers.push(candidate);
      index.set(resolved, importers);
    }
  }
  for (const importers of index.values()) importers.sort();
  return index;
}

export function importedBy(index: Map<string, string[]>, file: string): string[] {
  const target = normalize(file);
  return (index.get(comparable(target)) ?? []).filter((importer) => importer !== target);
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

export function repoFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files']).split('\n').filter(Boolean);
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Diff hunks and the growth line for one file vs the merge-base of baseRef. */
export function changeFacts(repoRoot: string, baseRef: string, file: string, content: string): { hunks: string; growth: string } {
  const lines = lineCount(content);
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
    const before = lineCount(git(repoRoot, ['show', `${base}:${file}`]));
    if (before === lines) return { hunks, growth: `unchanged at ${lines} lines` };
    return { hunks, growth: `${before < lines ? 'grew' : 'shrank'} from ${before} to ${lines} lines` };
  } catch {
    return { hunks, growth: `new file, ${lines} lines` };
  }
}
