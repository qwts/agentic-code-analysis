// Graded calibration (ACA-0012): the manifest is a versioned, validated exam
// with named cumulative qualification levels — not ENG-0151 routing tiers.
// This module holds the manifest types, validation, pure expectation
// matching, and grade calculation. No filesystem access — the self-test
// supplies fixture contents through a resolver, so a malformed or tampered
// package fails as a configuration/integrity error before any judge call.
// Expectations assert the structured testability footprint (dependency name
// + criterion, blocking vs residual), not just labels.
import { createHash } from 'node:crypto';
import { ConfigError } from '../../core/config.ts';
import { ASSESSMENTS, CRITERIA, type SeamAuditVerdict, type SeamDependency } from './judge-io.ts';

export interface FixtureSide {
  /** Bare file name inside the fixtures directory — never a path. */
  content: string;
  /** SHA-256 of the referenced file; a mismatch is an integrity error. */
  sha256: string;
}

/** One required footprint item: `dependency` matches by case-insensitive
 * substring of the judged stable name; `criterion` (optional) must match
 * exactly. The matched item must carry nonblank evidence and test_patch — a
 * bare label is not a detection. */
export interface FootprintExpectation {
  dependency: string;
  criterion?: string;
}

export interface Expectation {
  assessment: string;
  verdict: 'pass' | 'warn' | 'fail';
  blockingAllOf?: FootprintExpectation[];
  residualAllOf?: FootprintExpectation[];
  emptyFootprint?: boolean;
}

export interface CalibrationFixture {
  name: string;
  level: string;
  kind: 'new' | 'legacy';
  file: string;
  head: FixtureSide;
  base?: FixtureSide;
  expect: Expectation;
  /** Provenance and permission record — informational, never interpreted. */
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
// Bare names only: the manifest must not be able to read outside its own
// directory, and '..' is a name the resolver would happily traverse.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(detail: string): never {
  throw new ConfigError(`self-test manifest: ${detail}`);
}

function checkFootprint(name: string, field: string, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) fail(`fixture "${name}": ${field} must be a non-empty array`);
  for (const entry of value) {
    const e = entry as FootprintExpectation;
    if (typeof e !== 'object' || e === null || typeof e.dependency !== 'string' || e.dependency === '') {
      fail(`fixture "${name}": every ${field} entry needs a non-empty dependency`);
    }
    if (e.criterion !== undefined && !(CRITERIA as readonly string[]).includes(e.criterion)) {
      fail(`fixture "${name}": unknown criterion "${e.criterion}" in ${field}`);
    }
  }
}

function checkSide(name: string, label: string, value: unknown, contentOf: (file: string) => string | undefined): void {
  const side = value as FixtureSide;
  if (typeof side !== 'object' || side === null) fail(`fixture "${name}": ${label} must be an object`);
  if (typeof side.content !== 'string' || !SAFE_NAME.test(side.content) || side.content.includes('..')) {
    fail(`fixture "${name}": ${label} content must be a bare file name inside the fixtures directory`);
  }
  if (typeof side.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(side.sha256)) fail(`fixture "${name}": ${label} sha256 must be 64 lowercase hex chars`);
  const content = contentOf(side.content);
  if (content === undefined) fail(`fixture "${name}": ${label} file "${side.content}" is missing`);
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== side.sha256) fail(`fixture "${name}": ${label} file "${side.content}" fails its checksum (integrity error, not a judge miss)`);
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
    if (fixture.kind !== 'new' && fixture.kind !== 'legacy') fail(`fixture "${name}": kind must be "new" or "legacy"`);
    if (typeof fixture.file !== 'string' || fixture.file === '') fail(`fixture "${name}": file must be a non-empty path`);
    checkSide(name, 'head', fixture.head, contentOf);
    if (fixture.kind === 'legacy') {
      if (fixture.base === undefined) fail(`fixture "${name}": legacy comparisons require both snapshots`);
      checkSide(name, 'base', fixture.base, contentOf);
    } else if (fixture.base !== undefined) {
      // An unvalidated base on a new fixture would escape the checksum gate
      // and break suite identity.
      fail(`fixture "${name}": a new comparison must not carry a base snapshot`);
    }
    const expect = fixture.expect as Expectation;
    if (typeof expect !== 'object' || expect === null) fail(`fixture "${name}": expect must be an object`);
    if (!(ASSESSMENTS as readonly string[]).includes(expect.assessment)) fail(`fixture "${name}": unknown assessment ${JSON.stringify(expect.assessment)}`);
    if (!(VERDICTS as readonly string[]).includes(expect.verdict)) fail(`fixture "${name}": unknown verdict ${JSON.stringify(expect.verdict)}`);
    checkFootprint(name, 'blockingAllOf', expect.blockingAllOf);
    checkFootprint(name, 'residualAllOf', expect.residualAllOf);
    if (expect.emptyFootprint !== undefined && typeof expect.emptyFootprint !== 'boolean') fail(`fixture "${name}": emptyFootprint must be a boolean`);
    if (expect.emptyFootprint && (expect.blockingAllOf || expect.residualAllOf)) {
      fail(`fixture "${name}": emptyFootprint contradicts blockingAllOf/residualAllOf`);
    }
  }
  for (const id of levelIds) {
    if (!manifest.fixtures.some((fixture) => fixture.level === id)) fail(`level "${id}" has no fixtures — a level cannot pass vacuously`);
  }
  return manifest;
}

const nonblank = (text: string): boolean => text.trim().length > 0;
const BLOCKING = new Set(['new', 'introduced', 'worsened']);

function matchesItem(expect: FootprintExpectation, items: SeamDependency[]): boolean {
  return items.some(
    (item) =>
      item.dependency.toLowerCase().includes(expect.dependency.toLowerCase()) &&
      (expect.criterion === undefined || item.criterion === expect.criterion) &&
      nonblank(item.evidence) &&
      nonblank(item.test_patch),
  );
}

/** Pure oracle: does a judged verdict satisfy a fixture's expectation? A
 * residual expectation is met only by a pre-existing item — blocking items
 * cannot stand in — and vice versa. */
export function matchExpectation(expect: Expectation, verdict: SeamAuditVerdict): boolean {
  const footprint = verdict.testabilityFootprint ?? [];
  const blocking = footprint.filter((item) => BLOCKING.has(item.change));
  const residual = footprint.filter((item) => item.change === 'pre-existing');
  return (
    verdict.assessment === expect.assessment &&
    verdict.verdict === expect.verdict &&
    (!expect.emptyFootprint || footprint.length === 0) &&
    (!expect.blockingAllOf || expect.blockingAllOf.every((entry) => matchesItem(entry, blocking))) &&
    (!expect.residualAllOf || expect.residualAllOf.every((entry) => matchesItem(entry, residual)))
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
