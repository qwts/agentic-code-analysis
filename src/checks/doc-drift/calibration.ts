// Graded calibration for doc-drift, following ACA-0012's exam shape forked
// check-locally: a versioned, validated manifest of doc + referent-bundle
// fixtures with named cumulative qualification levels. Pure — no filesystem
// access; the self-test supplies fixture contents through a resolver, so a
// malformed or tampered package fails as a configuration/integrity error
// before any judge call. Expectations here are any-of sets because several
// fixtures assert "never fail" boundaries rather than one exact label.
import { createHash } from 'node:crypto';
import { ConfigError } from '../../core/config.ts';
import { ASSESSMENTS, CRITERIA, type DocDriftVerdict } from './judge-io.ts';

export interface FixtureFile {
  /** Bare file name inside the fixtures directory — never a path. */
  content: string;
  /** SHA-256 of the referenced file; a mismatch is an integrity error. */
  sha256: string;
}

export interface FixtureReferent {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'seeded';
  renamedTo?: string;
  head?: FixtureFile;
  base?: FixtureFile;
}

export interface Expectation {
  assessmentAnyOf: string[];
  verdictAnyOf: ('pass' | 'warn' | 'fail')[];
  criteriaAnyOf?: string[];
}

export interface CalibrationFixture {
  name: string;
  level: string;
  doc: FixtureFile & { path: string };
  referents: FixtureReferent[];
  expect: Expectation;
  /** Provenance record — informational, never interpreted. */
  source?: Record<string, unknown>;
}

export interface CalibrationManifest {
  schemaVersion: 1;
  requiredLevel: string;
  levels: { id: string }[];
  fixtures: CalibrationFixture[];
}

export type LevelStatus = 'passed' | 'failed' | 'skipped';

const VERDICTS = ['pass', 'warn', 'fail'] as const;
const STATUSES = ['added', 'modified', 'deleted', 'renamed', 'seeded'] as const;
// Bare names only: the manifest must not be able to read outside its own
// directory, and '..' is a name the resolver would happily traverse.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(detail: string): never {
  throw new ConfigError(`self-test manifest: ${detail}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkFile(name: string, label: string, value: unknown, contentOf: (file: string) => string | undefined): void {
  const file = value as FixtureFile;
  if (typeof file !== 'object' || file === null) fail(`fixture "${name}": ${label} must be an object`);
  if (typeof file.content !== 'string' || !SAFE_NAME.test(file.content) || file.content.includes('..')) {
    fail(`fixture "${name}": ${label} content must be a bare file name inside the fixtures directory`);
  }
  if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) fail(`fixture "${name}": ${label} sha256 must be 64 lowercase hex chars`);
  const content = contentOf(file.content);
  if (content === undefined) fail(`fixture "${name}": ${label} file "${file.content}" is missing`);
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== file.sha256) fail(`fixture "${name}": ${label} file "${file.content}" fails its checksum (integrity error, not a judge miss)`);
}

export function validateManifest(raw: unknown, contentOf: (file: string) => string | undefined): CalibrationManifest {
  const manifest = raw as CalibrationManifest;
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
    if (typeof fixture.doc !== 'object' || fixture.doc === null || typeof fixture.doc.path !== 'string' || fixture.doc.path === '') {
      fail(`fixture "${name}": doc needs a non-empty path`);
    }
    checkFile(name, 'doc', fixture.doc, contentOf);
    if (!Array.isArray(fixture.referents) || fixture.referents.length === 0) fail(`fixture "${name}": referents must be a non-empty array`);
    for (const referent of fixture.referents) {
      if (typeof referent !== 'object' || referent === null || typeof referent.path !== 'string' || referent.path === '') {
        fail(`fixture "${name}": every referent needs a non-empty path`);
      }
      if (!(STATUSES as readonly string[]).includes(referent.status)) fail(`fixture "${name}": unknown referent status ${JSON.stringify(referent.status)}`);
      if (referent.status === 'deleted') {
        if (referent.head !== undefined) fail(`fixture "${name}": a deleted referent must not carry head content`);
      } else if (referent.head === undefined) {
        fail(`fixture "${name}": a ${referent.status} referent needs head content`);
      }
      if (referent.status === 'renamed' && typeof referent.renamedTo !== 'string') fail(`fixture "${name}": a renamed referent needs renamedTo`);
      if (referent.head !== undefined) checkFile(name, `referent ${referent.path} head`, referent.head, contentOf);
      if (referent.base !== undefined) checkFile(name, `referent ${referent.path} base`, referent.base, contentOf);
    }
    const expect = fixture.expect as Expectation;
    if (typeof expect !== 'object' || expect === null) fail(`fixture "${name}": expect must be an object`);
    if (!isStringArray(expect.assessmentAnyOf) || expect.assessmentAnyOf.length === 0) fail(`fixture "${name}": assessmentAnyOf must be a non-empty string array`);
    for (const assessment of expect.assessmentAnyOf) {
      if (!(ASSESSMENTS as readonly string[]).includes(assessment)) fail(`fixture "${name}": unknown assessment ${JSON.stringify(assessment)}`);
    }
    if (!isStringArray(expect.verdictAnyOf) || expect.verdictAnyOf.length === 0) fail(`fixture "${name}": verdictAnyOf must be a non-empty string array`);
    for (const verdict of expect.verdictAnyOf) {
      if (!(VERDICTS as readonly string[]).includes(verdict)) fail(`fixture "${name}": unknown verdict ${JSON.stringify(verdict)}`);
    }
    if (expect.criteriaAnyOf !== undefined) {
      if (!isStringArray(expect.criteriaAnyOf) || expect.criteriaAnyOf.length === 0) fail(`fixture "${name}": criteriaAnyOf must be a non-empty string array`);
      for (const criterion of expect.criteriaAnyOf) {
        if (!(CRITERIA as readonly string[]).includes(criterion)) fail(`fixture "${name}": unknown criterion ${JSON.stringify(criterion)}`);
      }
    }
  }
  for (const id of levelIds) {
    if (!manifest.fixtures.some((fixture) => fixture.level === id)) fail(`level "${id}" has no fixtures — a level cannot pass vacuously`);
  }
  return manifest;
}

const nonblank = (text: string): boolean => text.trim().length > 0;

/** Pure oracle: does a judged verdict satisfy a fixture's expectation? A
 * criteria expectation is met only by a structured finding carrying that
 * criterion with nonblank claim, evidence, and suggestion — a bare label is
 * not a detection (reference-id validity is enforced upstream: an invalid
 * id degrades the verdict before it reaches this oracle). */
export function matchExpectation(expect: Expectation, verdict: DocDriftVerdict): boolean {
  const findings = verdict.findings ?? [];
  return (
    verdict.assessment !== undefined &&
    expect.assessmentAnyOf.includes(verdict.assessment) &&
    (expect.verdictAnyOf as string[]).includes(verdict.verdict) &&
    (!expect.criteriaAnyOf ||
      findings.some(
        (finding) =>
          expect.criteriaAnyOf!.includes(finding.criterion) && nonblank(finding.claim) && nonblank(finding.evidence) && nonblank(finding.suggestion),
      ))
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
 * Deterministic identity of the exam a qualification applies to: prompt and
 * extraction versions, rubric text, the manifest itself, and every
 * referenced fixture content in manifest order. Any change produces a new
 * identity, so recorded evidence cannot be mistaken for a later exam.
 */
export function suiteIdentity(versions: string[], rubric: string, manifestText: string, contents: string[]): string {
  const hash = createHash('sha256');
  for (const part of [...versions, rubric, manifestText, ...contents]) hash.update(part).update('\0');
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
