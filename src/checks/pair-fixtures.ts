// Pair-fixture corpus support (ACA-0020 D1/D2): harness infrastructure for
// diff-scoped checks' calibration, beside the registry — not a check, and
// never imported by production run paths. A case is a before/after file tree
// on disk; the diff is recomputed in memory on every load, so the exam
// always tests exactly what is on disk. Expectations assert ALL-of on
// criteria, each anchored to a file and optionally an exact head line.
// Validation mirrors the file-fixture manifest discipline (ACA-0012): a
// malformed package is a configuration error before any judge call, never a
// judge miss.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../core/config.ts';
import { diffArtifactFromTrees, type DiffArtifact } from '../core/diff-artifact.ts';

export interface PairExpectedCriterion {
  criterion: string;
  file: string;
  /** Exact head line the finding must anchor to; omit to accept any line. */
  line?: number;
}

export interface PairExpectation {
  verdict: 'pass' | 'warn' | 'fail';
  /** ALL must be matched by findings; empty for clean-pass fixtures. */
  criteria: PairExpectedCriterion[];
}

export interface PairFixture {
  name: string;
  level: string;
  /** Case directory (bare name) holding before/ and after/ trees. */
  dir: string;
  expect: PairExpectation;
  /** Provenance — informational, never interpreted. */
  source?: Record<string, unknown>;
}

export interface PairManifest {
  schemaVersion: 1;
  requiredLevel: string;
  levels: { id: string }[];
  fixtures: PairFixture[];
}

const VERDICTS = ['pass', 'warn', 'fail'] as const;
// Bare directory names only — the manifest must not read outside fixtures/.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(detail: string): never {
  throw new ConfigError(`pair-fixture manifest: ${detail}`);
}

export function validatePairManifest(raw: unknown, validCriteria: readonly string[]): PairManifest {
  const manifest = raw as PairManifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('must be an object');
  if (manifest.schemaVersion !== 1) fail(`unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)}; expected 1`);
  if (!Array.isArray(manifest.levels) || manifest.levels.length === 0) fail('levels must be a non-empty array');
  const levelIds: string[] = [];
  for (const level of manifest.levels) {
    if (typeof level !== 'object' || level === null || typeof level.id !== 'string' || level.id === '') fail('every level needs a non-empty string id');
    if (levelIds.includes(level.id)) fail(`duplicate level "${level.id}"`);
    levelIds.push(level.id);
  }
  if (typeof manifest.requiredLevel !== 'string' || !levelIds.includes(manifest.requiredLevel)) {
    fail(`requiredLevel ${JSON.stringify(manifest.requiredLevel)} is not a declared level`);
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) fail('fixtures must be a non-empty array');
  const names = new Set<string>();
  for (const fixture of manifest.fixtures) {
    if (typeof fixture !== 'object' || fixture === null || typeof fixture.name !== 'string' || fixture.name === '') fail('every fixture needs a non-empty name');
    const name = fixture.name;
    if (names.has(name)) fail(`duplicate fixture "${name}"`);
    names.add(name);
    if (!levelIds.includes(fixture.level)) fail(`fixture "${name}": unknown level ${JSON.stringify(fixture.level)}`);
    if (typeof fixture.dir !== 'string' || !SAFE_NAME.test(fixture.dir) || fixture.dir.includes('..')) {
      fail(`fixture "${name}": dir must be a bare directory name inside the fixtures directory`);
    }
    const expect = fixture.expect as PairExpectation;
    if (typeof expect !== 'object' || expect === null) fail(`fixture "${name}": expect must be an object`);
    if (!(VERDICTS as readonly string[]).includes(expect.verdict)) fail(`fixture "${name}": unknown verdict ${JSON.stringify(expect.verdict)}`);
    if (!Array.isArray(expect.criteria)) fail(`fixture "${name}": expect.criteria must be an array`);
    for (const criterion of expect.criteria as PairExpectedCriterion[]) {
      if (typeof criterion !== 'object' || criterion === null) fail(`fixture "${name}": every expected criterion must be an object`);
      if (!validCriteria.includes(criterion.criterion)) fail(`fixture "${name}": unknown criterion ${JSON.stringify(criterion.criterion)}`);
      if (typeof criterion.file !== 'string' || criterion.file === '') fail(`fixture "${name}": expected criterion needs a non-empty file`);
      if (criterion.line !== undefined && (!Number.isInteger(criterion.line) || criterion.line < 1)) {
        fail(`fixture "${name}": expected line must be a positive integer`);
      }
    }
  }
  for (const id of levelIds) {
    if (!manifest.fixtures.some((fixture) => fixture.level === id)) fail(`level "${id}" has no fixtures — a level cannot pass vacuously`);
  }
  return manifest;
}

/** Read one side of a case into a path → content map (posix-relative keys). */
export function loadTree(root: string): Map<string, string> {
  const tree = new Map<string, string>();
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return tree;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const key = relative(root, absolute).split(sep).join('/');
    tree.set(key, readFileSync(absolute, 'utf8'));
  }
  return new Map([...tree.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface LoadedPairCase {
  before: Map<string, string>;
  after: Map<string, string>;
  artifact: DiffArtifact;
}

export function loadPairCase(fixturesDir: URL, fixture: PairFixture): LoadedPairCase {
  const caseRoot = fileURLToPath(new URL(`${fixture.dir}/`, fixturesDir));
  const before = loadTree(join(caseRoot, 'before'));
  const after = loadTree(join(caseRoot, 'after'));
  if (before.size === 0 && after.size === 0) fail(`fixture "${fixture.name}": no files under ${fixture.dir}/{before,after}`);
  return { before, after, artifact: diffArtifactFromTrees(before, after) };
}

/** The judged shape the oracle asserts on — checks map their outcome to it. */
export interface PairOutcome {
  verdict: string;
  findings: { criterion: string; file: string; line: number }[];
}

/** Pure oracle: verdict must match and EVERY expected criterion must be
 * detected at its anchor — a pair fixture built to demonstrate two smells is
 * missed if either goes undetected. */
export function matchPairExpectation(expect: PairExpectation, outcome: PairOutcome): boolean {
  return (
    outcome.verdict === expect.verdict &&
    expect.criteria.every((expected) =>
      outcome.findings.some(
        (finding) =>
          finding.criterion === expected.criterion &&
          finding.file === expected.file &&
          (expected.line === undefined || finding.line === expected.line),
      ),
    )
  );
}

/**
 * Deterministic identity of a pair exam: prompt version, manifest text, and
 * every tree file (path and content) in load order. Any change produces a
 * new identity, so recorded evidence cannot be mistaken for a later exam.
 */
export function pairSuiteIdentity(promptVersion: string, manifestText: string, cases: LoadedPairCase[]): string {
  const hash = createHash('sha256');
  hash.update(promptVersion).update('\0').update(manifestText).update('\0');
  for (const loaded of cases) {
    for (const [side, tree] of [
      ['before', loaded.before],
      ['after', loaded.after],
    ] as const) {
      for (const [path, content] of tree) hash.update(side).update('\0').update(path).update('\0').update(content).update('\0');
    }
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
