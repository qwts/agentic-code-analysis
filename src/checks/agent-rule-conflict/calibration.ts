// Graded calibration (ACA-0012): the manifest is a versioned, validated exam
// over fixture repository trees. This module holds the manifest types,
// integrity validation (safe names, per-file checksums, exact listings),
// the pure expectation oracle over check verdicts, and grade calculation.
// No filesystem access — the self-test supplies tree listings and contents
// through resolvers, so a malformed or tampered package fails as a
// configuration/integrity error before any judge call.
import { createHash } from 'node:crypto';
import { ConfigError } from '../../core/config.ts';
import { ASSESSMENTS, CRITERIA } from './judge-io.ts';
import { CORPUS_ROW, type AttributedFinding, type ConflictVerdict } from './outcome.ts';

export interface CalibrationFixture {
  name: string;
  level: string;
  /** Tree directory name inside fixtures/ — never a path. */
  tree: string;
  /** Exact listing: tree-relative POSIX path -> SHA-256 of its content. */
  files: Record<string, string>;
  expect: Expectation;
  /** Provenance record — informational, never interpreted. */
  source?: Record<string, unknown>;
}

export interface Expectation {
  assessment: string;
  verdict: 'pass' | 'warn' | 'fail';
  criteriaAnyOf?: string[];
  /** 'some' requires a qualifying finding with shared sessions; 'none'
   * requires one whose sessionsLoadingBoth is explicitly empty. */
  sharedSessions?: 'some' | 'none';
}

export interface CalibrationManifest {
  schemaVersion: 1;
  requiredLevel: string;
  levels: { id: string }[];
  fixtures: CalibrationFixture[];
}

export type LevelStatus = 'passed' | 'failed' | 'skipped';

export interface TreeResolver {
  /** Sorted tree-relative POSIX file paths, or undefined for a missing tree. */
  listTree(tree: string): string[] | undefined;
  contentOf(tree: string, path: string): string | undefined;
}

const VERDICTS = ['pass', 'warn', 'fail'] as const;
// Bare names only: the manifest must not be able to read outside its own
// directory. Path segments may start with a dot (.github) but never be
// '.' or '..'.
const SAFE_TREE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

function fail(detail: string): never {
  throw new ConfigError(`self-test manifest: ${detail}`);
}

const safePath = (path: string): boolean => path.split('/').every((segment) => SAFE_SEGMENT.test(segment));

export function validateManifest(raw: unknown, resolver: TreeResolver): CalibrationManifest {
  const manifest = raw as CalibrationManifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('must be an object (schemaVersion 1)');
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
    if (typeof fixture.tree !== 'string' || !SAFE_TREE.test(fixture.tree)) fail(`fixture "${name}": tree must be a bare directory name`);
    if (typeof fixture.files !== 'object' || fixture.files === null || Object.keys(fixture.files).length === 0) {
      fail(`fixture "${name}": files must map at least one tree path to a checksum`);
    }
    const declared = Object.keys(fixture.files).sort();
    for (const path of declared) {
      if (!safePath(path)) fail(`fixture "${name}": unsafe tree path "${path}"`);
      const sha = fixture.files[path];
      if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) fail(`fixture "${name}": sha256 for "${path}" must be 64 lowercase hex chars`);
      const content = resolver.contentOf(fixture.tree, path);
      if (content === undefined) fail(`fixture "${name}": tree file "${fixture.tree}/${path}" is missing`);
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== sha) fail(`fixture "${name}": "${fixture.tree}/${path}" fails its checksum (integrity error, not a judge miss)`);
    }
    const actualListing = resolver.listTree(fixture.tree);
    if (actualListing === undefined) fail(`fixture "${name}": tree "${fixture.tree}" is missing`);
    if (JSON.stringify(actualListing) !== JSON.stringify(declared)) {
      fail(`fixture "${name}": tree "${fixture.tree}" listing differs from the manifest (undeclared or missing files change discovery)`);
    }
    const expect = fixture.expect as Expectation;
    if (typeof expect !== 'object' || expect === null) fail(`fixture "${name}": expect must be an object`);
    if (!(ASSESSMENTS as readonly string[]).includes(expect.assessment)) fail(`fixture "${name}": unknown assessment ${JSON.stringify(expect.assessment)}`);
    if (!(VERDICTS as readonly string[]).includes(expect.verdict)) fail(`fixture "${name}": unknown verdict ${JSON.stringify(expect.verdict)}`);
    if (expect.criteriaAnyOf !== undefined) {
      if (!Array.isArray(expect.criteriaAnyOf) || expect.criteriaAnyOf.length === 0 || expect.criteriaAnyOf.some((c) => typeof c !== 'string')) {
        fail(`fixture "${name}": criteriaAnyOf must be a non-empty string array`);
      }
      for (const criterion of expect.criteriaAnyOf) {
        if (!(CRITERIA as readonly string[]).includes(criterion)) fail(`fixture "${name}": unknown criteriaAnyOf entry "${criterion}"`);
      }
    }
    if (expect.sharedSessions !== undefined && expect.sharedSessions !== 'some' && expect.sharedSessions !== 'none') {
      fail(`fixture "${name}": sharedSessions must be "some" or "none"`);
    }
  }
  for (const id of levelIds) {
    if (!manifest.fixtures.some((fixture) => fixture.level === id)) fail(`level "${id}" has no fixtures — a level cannot pass vacuously`);
  }
  return manifest;
}

const nonblank = (text: string): boolean => text.trim().length > 0;

/** The findings of every non-corpus row. */
export function findingsOf(verdicts: readonly ConflictVerdict[]): AttributedFinding[] {
  return verdicts.filter((v) => v.file !== CORPUS_ROW).flatMap((v) => v.findings ?? []);
}

/**
 * Pure oracle over the production verdict rows: assessment, effective
 * verdict, criterion with grounded quotes, shared-session attribution, and
 * resolution shape — never only the top-level color (check design).
 */
export function matchExpectation(expect: Expectation, verdicts: readonly ConflictVerdict[]): boolean {
  const corpus = verdicts.find((v) => v.file === CORPUS_ROW);
  if (corpus === undefined) return false;
  const findings = findingsOf(verdicts);
  const effective: Expectation['verdict'] = findings.some((f) => f.verdict === 'fail')
    ? 'fail'
    : findings.length > 0 || corpus.verdict === 'warn'
      ? 'warn'
      : 'pass';
  if (effective !== expect.verdict) return false;
  const assessment = (corpus as { assessment?: string }).assessment;
  if (assessment !== expect.assessment) return false;
  if (expect.criteriaAnyOf === undefined && expect.sharedSessions === undefined) {
    return expect.verdict === 'pass' ? findings.length === 0 : true;
  }
  return findings.some(
    (finding) =>
      (expect.criteriaAnyOf === undefined || expect.criteriaAnyOf.includes(finding.criterion)) &&
      (expect.sharedSessions === undefined ||
        (expect.sharedSessions === 'some' ? finding.sessionsLoadingBoth.length > 0 : finding.sessionsLoadingBoth.length === 0)) &&
      nonblank(finding.ruleA.quote) &&
      nonblank(finding.ruleB.quote) &&
      nonblank(finding.explanation) &&
      nonblank(finding.suggestion),
  );
}

/** Highest contiguous passing level — no averaging, no partial credit. */
export function achievedLevel(levelIds: string[], status: ReadonlyMap<string, LevelStatus>): string | null {
  let achieved: string | null = null;
  for (const id of levelIds) {
    if (status.get(id) !== 'passed') break;
    achieved = id;
  }
  return achieved;
}

export function qualifies(levelIds: string[], achieved: string | null, required: string): boolean {
  return achieved !== null && levelIds.indexOf(achieved) >= levelIds.indexOf(required);
}

/**
 * Deterministic identity of the exam a qualification applies to: prompt
 * version, rubric text, the manifest itself, and every referenced tree file
 * in manifest order. Any change produces a new identity.
 */
export function suiteIdentity(promptVersion: string, rubric: string, manifestText: string, contents: string[]): string {
  const hash = createHash('sha256');
  for (const part of [promptVersion, rubric, manifestText, ...contents]) hash.update(part).update('\0');
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
