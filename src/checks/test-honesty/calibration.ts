// Graded calibration (ACA-0012): the manifest is a versioned, validated exam
// with named cumulative qualification levels — not ENG-0151 routing tiers.
// Check-local fork bound to this check's criteria, assessments, and
// non-comparative evidence shape: one test-file snapshot per fixture, with
// companion unit/snapshot context carried inline by the manifest. No
// filesystem access — the self-test supplies fixture contents through a
// resolver, so a malformed or tampered package fails as a
// configuration/integrity error before any judge call.
import { createHash } from 'node:crypto';
import { ConfigError } from '../../core/config.ts';
import { ASSESSMENTS, CRITERIA, type TestHonestyVerdict } from './judge-io.ts';
import type { SnapshotContext, UnitContext } from './unit-context.ts';

export interface Expectation {
  assessment: string;
  verdict: 'pass' | 'warn' | 'fail';
  criteriaAnyOf?: string[];
  testNameIncludes?: string;
}

export interface CalibrationFixture {
  name: string;
  level: string;
  file: string;
  /** Bare file name inside the fixtures directory — never a path. */
  content: string;
  /** SHA-256 of the referenced file; a mismatch is an integrity error. */
  sha256: string;
  units: UnitContext[];
  snapshots: SnapshotContext[];
  unavailable: string[];
  expect: Expectation;
  /** Provenance and permission record — informational, never interpreted. */
  source?: Record<string, unknown>;
}

export interface CalibrationManifest {
  schemaVersion: 2;
  requiredLevel: string;
  levels: { id: string }[];
  fixtures: CalibrationFixture[];
}

export type LevelStatus = 'passed' | 'failed' | 'skipped';

const VERDICTS = ['pass', 'warn', 'fail'] as const;
// Bare names only: the manifest must not be able to read outside its own
// directory, and '..' is a name the resolver would happily traverse.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(detail: string): never {
  throw new ConfigError(`self-test manifest: ${detail}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkUnits(name: string, value: unknown): void {
  if (!Array.isArray(value)) fail(`fixture "${name}": units must be an array`);
  for (const unit of value as UnitContext[]) {
    if (typeof unit !== 'object' || unit === null || typeof unit.path !== 'string' || !isStringArray(unit.exports)) {
      fail(`fixture "${name}": every unit needs a string path and a string-array exports`);
    }
  }
}

function checkSnapshots(name: string, value: unknown): void {
  if (!Array.isArray(value)) fail(`fixture "${name}": snapshots must be an array`);
  for (const snapshot of value as SnapshotContext[]) {
    if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.path !== 'string' || typeof snapshot.content !== 'string') {
      fail(`fixture "${name}": every snapshot needs a string path and content`);
    }
  }
}

export function validateManifest(raw: unknown, contentOf: (file: string) => string | undefined): CalibrationManifest {
  const manifest = raw as CalibrationManifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('must be an object (schemaVersion 2), not an array');
  if (manifest.schemaVersion !== 2) fail(`unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)}; expected 2`);
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
    if (typeof fixture.file !== 'string' || fixture.file === '') fail(`fixture "${name}": file must be a non-empty path`);
    if (typeof fixture.content !== 'string' || !SAFE_NAME.test(fixture.content) || fixture.content.includes('..')) {
      fail(`fixture "${name}": content must be a bare file name inside the fixtures directory`);
    }
    if (typeof fixture.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fixture.sha256)) fail(`fixture "${name}": sha256 must be 64 lowercase hex chars`);
    const content = contentOf(fixture.content);
    if (content === undefined) fail(`fixture "${name}": file "${fixture.content}" is missing`);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== fixture.sha256) fail(`fixture "${name}": file "${fixture.content}" fails its checksum (integrity error, not a judge miss)`);
    checkUnits(name, fixture.units);
    checkSnapshots(name, fixture.snapshots);
    if (!isStringArray(fixture.unavailable)) fail(`fixture "${name}": unavailable must be a string array`);
    const expect = fixture.expect as Expectation;
    if (typeof expect !== 'object' || expect === null) fail(`fixture "${name}": expect must be an object`);
    if (!(ASSESSMENTS as readonly string[]).includes(expect.assessment)) fail(`fixture "${name}": unknown assessment ${JSON.stringify(expect.assessment)}`);
    if (!(VERDICTS as readonly string[]).includes(expect.verdict)) fail(`fixture "${name}": unknown verdict ${JSON.stringify(expect.verdict)}`);
    if (expect.criteriaAnyOf !== undefined) {
      if (!isStringArray(expect.criteriaAnyOf) || expect.criteriaAnyOf.length === 0) fail(`fixture "${name}": criteriaAnyOf must be a non-empty string array`);
      for (const criterion of expect.criteriaAnyOf) {
        if (!(CRITERIA as readonly string[]).includes(criterion)) fail(`fixture "${name}": unknown criterion "${criterion}" in criteriaAnyOf`);
      }
    }
    if (expect.testNameIncludes !== undefined && (typeof expect.testNameIncludes !== 'string' || expect.testNameIncludes === '')) {
      fail(`fixture "${name}": testNameIncludes must be a non-empty string`);
    }
  }
  for (const id of levelIds) {
    if (!manifest.fixtures.some((fixture) => fixture.level === id)) fail(`level "${id}" has no fixtures — a level cannot pass vacuously`);
  }
  return manifest;
}

/** Pure oracle: does a judged verdict satisfy a fixture's expectation?
 * Criteria matches must carry the named test when the expectation pins one,
 * and every fail must state what a discriminating assertion would establish
 * — a bare label is not a detection. */
export function matchExpectation(expect: Expectation, verdict: TestHonestyVerdict): boolean {
  const findings = verdict.findings ?? [];
  const matching = expect.criteriaAnyOf ? findings.filter((finding) => expect.criteriaAnyOf!.includes(finding.criterion)) : findings;
  return (
    verdict.assessment === expect.assessment &&
    verdict.verdict === expect.verdict &&
    (!expect.criteriaAnyOf || matching.length > 0) &&
    (!expect.testNameIncludes || matching.some((finding) => finding.test.includes(expect.testNameIncludes!))) &&
    (expect.verdict !== 'fail' || matching.some((finding) => finding.meaningful_assertion.trim() !== ''))
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
 * version, rubric text, the manifest itself, and every referenced fixture
 * content in manifest order. Any change produces a new identity, so recorded
 * evidence cannot be mistaken for a later exam.
 */
export function suiteIdentity(promptVersion: string, rubric: string, manifestText: string, contents: string[]): string {
  const hash = createHash('sha256');
  for (const part of [promptVersion, rubric, manifestText, ...contents]) hash.update(part).update('\0');
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
