// Checksummed tree-manifest validation and cumulative grading for the live
// skill-package calibration exam. Integrity errors stop before judge spend.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ConfigError } from '../../core/config.ts';
import { ACTIONS, ASSESSMENTS, CRITERIA, type SkillInformationArchitectureVerdict } from './judge-io.ts';

export interface FixtureExpectation {
  assessment: string;
  verdict: 'pass' | 'warn' | 'fail';
  criteriaAnyOf?: string[];
  actionsAnyOf?: string[];
}

export interface CalibrationFixture {
  name: string;
  level: string;
  root: string;
  files: { path: string; sha256: string }[];
  expect: FixtureExpectation;
  sameBodyTokensAs?: string;
}

export interface CalibrationManifest {
  schemaVersion: 1;
  requiredLevel: string;
  levels: { id: string }[];
  fixtures: CalibrationFixture[];
}

export type LevelStatus = 'passed' | 'failed' | 'skipped';
const SAFE_BARE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/u;

function fail(detail: string): never {
  throw new ConfigError(`self-test manifest: ${detail}`);
}

function enumArray(name: string, field: string, value: unknown, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry))) {
    fail(`fixture "${name}": ${field} must contain known values`);
  }
}

function actualFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix.join(entry.parentPath.slice(root.length + 1).replaceAll('\\', '/'), entry.name).replace(/^\//u, ''))
    .sort();
}

export function validateManifest(raw: unknown, fixturesDir: string): CalibrationManifest {
  const manifest = raw as CalibrationManifest;
  if (typeof manifest !== 'object' || manifest === null || manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!Array.isArray(manifest.levels) || manifest.levels.length === 0) fail('levels must be non-empty');
  const levels = manifest.levels.map((level) => level?.id);
  if (levels.some((id) => typeof id !== 'string' || id === '') || new Set(levels).size !== levels.length) fail('level ids must be unique non-empty strings');
  if (!levels.includes(manifest.requiredLevel)) fail('requiredLevel must name a declared level');
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) fail('fixtures must be non-empty');
  const names = new Set<string>();
  for (const fixture of manifest.fixtures) {
    if (typeof fixture?.name !== 'string' || fixture.name === '' || names.has(fixture.name)) fail('fixture names must be unique and non-empty');
    names.add(fixture.name);
    if (!levels.includes(fixture.level)) fail(`fixture "${fixture.name}": unknown level`);
    if (!SAFE_BARE.test(fixture.root) || fixture.root.includes('..')) fail(`fixture "${fixture.name}": root must be a bare directory name`);
    if (!Array.isArray(fixture.files) || fixture.files.length === 0) fail(`fixture "${fixture.name}": files must be non-empty`);
    const listed = fixture.files.map((file) => file.path).sort();
    for (const file of fixture.files) {
      if (typeof file.path !== 'string' || !SAFE_PATH.test(file.path) || file.path.startsWith('/') || posix.normalize(file.path).startsWith('../')) fail(`fixture "${fixture.name}": unsafe file path`);
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) fail(`fixture "${fixture.name}": bad checksum for ${file.path}`);
      const content = readFileSync(join(fixturesDir, fixture.root, file.path));
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== file.sha256) fail(`fixture "${fixture.name}": checksum mismatch for ${file.path}`);
    }
    const actual = actualFiles(join(fixturesDir, fixture.root));
    if (JSON.stringify(actual) !== JSON.stringify(listed)) fail(`fixture "${fixture.name}": manifest does not cover the complete package tree`);
    const expect = fixture.expect;
    if (typeof expect !== 'object' || expect === null || !(ASSESSMENTS as readonly string[]).includes(expect.assessment)) fail(`fixture "${fixture.name}": unknown assessment`);
    if (!['pass', 'warn', 'fail'].includes(expect.verdict)) fail(`fixture "${fixture.name}": unknown verdict`);
    enumArray(fixture.name, 'criteriaAnyOf', expect.criteriaAnyOf, CRITERIA);
    enumArray(fixture.name, 'actionsAnyOf', expect.actionsAnyOf, ACTIONS);
  }
  for (const level of levels) if (!manifest.fixtures.some((fixture) => fixture.level === level)) fail(`level "${level}" has no fixtures`);
  for (const fixture of manifest.fixtures) {
    if (fixture.sameBodyTokensAs !== undefined && !names.has(fixture.sameBodyTokensAs)) fail(`fixture "${fixture.name}": unknown sameBodyTokensAs target`);
  }
  return manifest;
}

export function matchExpectation(expect: FixtureExpectation, verdict: SkillInformationArchitectureVerdict): boolean {
  const findings = verdict.findings ?? [];
  return verdict.assessment === expect.assessment && verdict.verdict === expect.verdict &&
    (expect.criteriaAnyOf === undefined || findings.some((finding) => expect.criteriaAnyOf!.includes(finding.criterion))) &&
    (expect.actionsAnyOf === undefined || findings.some((finding) => expect.actionsAnyOf!.includes(finding.action)));
}

export function achievedLevel(ids: readonly string[], status: ReadonlyMap<string, LevelStatus>): string | null {
  let achieved: string | null = null;
  for (const id of ids) {
    if (status.get(id) !== 'passed') break;
    achieved = id;
  }
  return achieved;
}

export function suiteIdentity(promptVersion: string, prompt: string, manifestText: string, contents: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const value of [promptVersion, prompt, manifestText]) hash.update(value).update('\0');
  for (const content of contents) hash.update(content).update('\0');
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
