// Import-graph derivations for the judge payload: import paths and
// imported-by paths, per snapshot. Paths only, never contents — they exist so
// the judge sees which boundaries a file sits behind instead of guessing.
// Check-local fork of the context-footprint shape (ACA-0003 D1: checks never
// import each other). Git snapshot assembly lives in comparison.ts; this
// module never runs git.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
export const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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

/** Read the code files of one snapshot once; both graph builds and the
 * per-file judge payloads draw from this map instead of re-reading disk.
 * Declared best-effort: an unreadable neighbor drops out of the importer
 * graph only — a judged file that is itself unreadable degrades to a warn
 * per file in comparison.ts, never silently. */
export function readContents(repoRoot: string, files: string[]): Map<string, string> {
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!CODE_EXT.test(file)) continue;
    try {
      contents.set(file, readFileSync(join(repoRoot, file), 'utf8'));
    } catch {
      continue;
    }
  }
  return contents;
}

/** One pass over a snapshot's contents builds the reverse import graph;
 * per-file lookups are then O(1). */
export function buildImporterIndex(contents: ReadonlyMap<string, string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [candidate, content] of contents) {
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
