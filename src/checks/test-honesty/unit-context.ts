// Best-effort companion evidence for one test file (check design: Judge
// input): the unit under test's export surface and conventionally adjacent
// external snapshots, resolved deterministically from direct static local
// imports — JS/TS family only in v1, everything else degrades to
// test-file-only judgment with an explicit unavailable marker. Failure to
// resolve is never a finding. No build systems, ASTs, or module loading.
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { isTestFile } from './scope.ts';

export interface UnitContext {
  path: string;
  exports: string[];
}

export interface SnapshotContext {
  path: string;
  content: string;
}

/** Everything the judge sees for one file; also the cache-key material. */
export interface Evidence {
  file: string;
  content: string;
  mode: 'unit-exports' | 'test-only';
  units: UnitContext[];
  snapshots: SnapshotContext[];
  /** Explicit markers for evidence that could not be resolved — the judge
   * always knows what it cannot see. */
  unavailable: string[];
}

// Bounds (check design): companion context must never dominate the request.
export const MAX_UNITS = 2;
export const MAX_SNAPSHOTS = 2;
export const MAX_COMPANION_BYTES = 16 * 1024;
export const MAX_TOTAL_COMPANION_BYTES = 48 * 1024;

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"](\.[^'"]+)['"]|\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXT_CANDIDATES = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'];
const EXPORT_LINE = /^\s*(?:export\s|module\.exports|exports\.)/;
const EXTERNAL_SNAPSHOT = /\.toMatch(?:File)?Snapshot\s*\(/;

/** Helper/fixture/mock modules are support code, not the unit under test. */
function isSupportModule(path: string, testGlobs: readonly string[]): boolean {
  if (isTestFile(path, testGlobs)) return true;
  if (path.split('/').some((segment) => segment === '__mocks__' || segment === 'fixtures')) return true;
  const name = basename(path).replace(CODE_EXT, '');
  return name === 'helper' || name.endsWith('helpers') || name.endsWith('-helper');
}

/** Resolve a relative specifier to an existing repo-relative code file, or
 * undefined. Deterministic: fixed extension order, no package.json logic. */
function resolveUnitPath(repoRoot: string, testFile: string, spec: string): string | undefined {
  const base = normalize(join(dirname(testFile), spec));
  if (base.startsWith('..')) return undefined; // must remain inside the repository
  const candidates = CODE_EXT.test(base) ? [base] : EXT_CANDIDATES.map((ext) => base + ext);
  for (const candidate of candidates) {
    try {
      if (statSync(join(repoRoot, candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function exportSurface(content: string): string[] {
  return content.split('\n').filter((line) => EXPORT_LINE.test(line));
}

/**
 * Builds the judge's evidence for one readable test file. Units come from
 * direct static local imports in source order, skipping support modules;
 * snapshots from the jest/vitest `__snapshots__/<name>.snap` convention.
 * Anything unresolved, unsupported, or over-bound becomes a marker.
 */
export function buildEvidence(repoRoot: string, file: string, content: string, testGlobs: readonly string[]): Evidence {
  const evidence: Evidence = { file, content, mode: 'test-only', units: [], snapshots: [], unavailable: [] };
  let budget = MAX_TOTAL_COMPANION_BYTES;
  const take = (text: string): string | undefined => {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_COMPANION_BYTES || bytes > budget) return undefined;
    budget -= bytes;
    return text;
  };

  if (CODE_EXT.test(file)) {
    const seen = new Set<string>();
    for (const match of content.matchAll(RELATIVE_IMPORT)) {
      if (evidence.units.length >= MAX_UNITS) break;
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const resolved = resolveUnitPath(repoRoot, file, spec);
      if (resolved === undefined) {
        evidence.unavailable.push(`unit exports unavailable: ${spec}`);
        continue;
      }
      if (seen.has(resolved) || isSupportModule(resolved, testGlobs)) continue;
      seen.add(resolved);
      let surface: string | undefined;
      try {
        surface = take(exportSurface(readFileSync(join(repoRoot, resolved), 'utf8')).join('\n'));
      } catch {
        surface = undefined;
      }
      if (surface === undefined) evidence.unavailable.push(`unit exports unavailable: ${resolved}`);
      else evidence.units.push({ path: resolved, exports: surface === '' ? [] : surface.split('\n') });
    }
  }
  if (evidence.units.length > 0) evidence.mode = 'unit-exports';
  else evidence.unavailable.push('unit exports unavailable');

  if (EXTERNAL_SNAPSHOT.test(content)) {
    const snapshotPath = normalize(join(dirname(file), '__snapshots__', `${basename(file)}.snap`));
    let snapshot: string | undefined;
    try {
      snapshot = take(readFileSync(join(repoRoot, snapshotPath), 'utf8'));
    } catch {
      snapshot = undefined;
    }
    if (snapshot === undefined) evidence.unavailable.push(`snapshot unavailable: ${snapshotPath}`);
    else if (evidence.snapshots.length < MAX_SNAPSHOTS) evidence.snapshots.push({ path: snapshotPath, content: snapshot });
  }
  return evidence;
}

/** The deterministic backstop for the rubric's evidence discipline: an
 * external snapshot the judge never saw cannot support a fail. */
export function externalSnapshotUnresolved(evidence: Evidence): boolean {
  return evidence.unavailable.some((marker) => marker.startsWith('snapshot unavailable'));
}
