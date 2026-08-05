// Calibration self-test over pair fixtures (ACA-0020, graded per ACA-0012):
// each case's before/after trees are diffed in memory into the same
// canonical artifact production builds from git, judged live through the
// production prompt, schema, anchor validator, and outcome mapping — one
// call per fixture, never cached. If an assertion breaks, the prompt is
// wrong, not the fixture. Levels run in manifest order; once a level fails,
// higher levels are skipped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import { addedLineIndex, MAX_PAYLOAD_CHARS, renderPayload } from '../../core/diff-artifact.ts';
import {
  loadPairCase,
  matchPairExpectation,
  pairSuiteIdentity,
  validatePairManifest,
  type LoadedPairCase,
  type PairExpectation,
  type PairFixture,
} from '../pair-fixtures.ts';
import { CRITERIA, judgeOutcome, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA, type ArtifactOutcome } from './judge-io.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

type LevelStatus = 'passed' | 'failed' | 'skipped';

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: PairExpectation;
  actual?: { assessment?: string; verdict: string; findings: { criterion: string; file: string; line: number }[]; note?: string };
}

/** Machine-readable qualification record (ACA-0012 shape for pair exams). */
export interface SelfTestReport {
  promptVersion: string;
  fixtureSuite: string;
  requiredLevel: string;
  achievedLevel: string | null;
  qualified: boolean;
  levels: { id: string; status: LevelStatus }[];
  fixtures: FixtureReport[];
}

export interface GradedSelfTestResult extends SelfTestResult {
  report: SelfTestReport;
}

function describeOutcome(outcome: ArtifactOutcome): string {
  const findings = outcome.findings.map((finding) => `${finding.criterion}@${finding.file}:${finding.line}`);
  return [
    `${outcome.assessment ?? 'degraded'}/${outcome.verdict}`,
    findings.length ? `[${findings.join(', ')}]` : '',
    outcome.note ? `(${outcome.note})` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function describeExpectation(expect: PairExpectation): string {
  const criteria = expect.criteria.map((c) => `${c.criterion}@${c.file}${c.line !== undefined ? `:${c.line}` : ''}`);
  return [`${expect.verdict}`, criteria.length ? `[all of: ${criteria.join(', ')}]` : '[no findings]'].join(' ');
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  const manifestText = readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new ConfigError(`pair-fixture manifest: invalid JSON — ${(err as Error).message}`);
  }
  const manifest = validatePairManifest(raw, CRITERIA);
  const cases = new Map<string, LoadedPairCase>(manifest.fixtures.map((fixture) => [fixture.name, loadPairCase(FIXTURES_DIR, fixture)]));
  const fixtureSuite = pairSuiteIdentity(PROMPT_VERSION, manifestText, [...cases.values()]);
  const system = systemPrompt();

  const levelIds = manifest.levels.map((level) => level.id);
  const levelStatus = new Map<string, LevelStatus>();
  const reports = new Map<string, FixtureReport>();
  const lines: string[] = [`self-test (${PROMPT_VERSION}, suite ${fixtureSuite}) via ${client.provider}/${client.model}`];

  let stopped = false;
  for (const id of levelIds) {
    const fixtures = manifest.fixtures.filter((fixture) => fixture.level === id);
    if (stopped) {
      levelStatus.set(id, 'skipped');
      for (const fixture of fixtures) {
        reports.set(fixture.name, { name: fixture.name, level: id, status: 'skipped', expected: fixture.expect });
        lines.push(`skip [${id}] ${fixture.name}: a lower level missed`);
      }
      continue;
    }
    let passed = true;
    // Sequential: one whole-artifact call per fixture; there is no per-file
    // pool to reuse and fixture counts stay small.
    for (const fixture of fixtures) {
      const outcome = await judgeFixture(client, system, cases.get(fixture.name)!);
      const ok = matchPairExpectation(fixture.expect, {
        verdict: outcome.verdict,
        findings: outcome.findings.map((finding) => ({ criterion: finding.criterion, file: finding.file, line: finding.line })),
      });
      if (!ok) passed = false;
      reports.set(fixture.name, {
        name: fixture.name,
        level: id,
        status: ok ? 'ok' : 'miss',
        expected: fixture.expect,
        actual: {
          ...(outcome.assessment !== undefined ? { assessment: outcome.assessment } : {}),
          verdict: outcome.verdict,
          findings: outcome.findings.map((finding) => ({ criterion: finding.criterion, file: finding.file, line: finding.line })),
          ...(outcome.note !== undefined ? { note: outcome.note } : {}),
        },
      });
      lines.push(`${ok ? 'ok' : 'MISS'} [${id}] ${fixture.name}: got ${describeOutcome(outcome)}, expected ${describeExpectation(fixture.expect)}`);
    }
    levelStatus.set(id, passed ? 'passed' : 'failed');
    if (!passed) stopped = true;
  }

  let achieved: string | null = null;
  for (const id of levelIds) {
    if (levelStatus.get(id) !== 'passed') break;
    achieved = id;
  }
  const qualified = achieved !== null && levelIds.indexOf(achieved) >= levelIds.indexOf(manifest.requiredLevel);
  lines.push(`qualification: achieved ${achieved ?? 'none'}, required ${manifest.requiredLevel}`);

  return {
    passed: qualified,
    lines,
    report: {
      promptVersion: PROMPT_VERSION,
      fixtureSuite,
      requiredLevel: manifest.requiredLevel,
      achievedLevel: achieved,
      qualified,
      levels: levelIds.map((id) => ({ id, status: levelStatus.get(id)! })),
      fixtures: manifest.fixtures.map((fixture) => reports.get(fixture.name)!),
    },
  };
}

async function judgeFixture(client: JudgeClient, system: string, loaded: LoadedPairCase): Promise<ArtifactOutcome> {
  const payload = renderPayload(loaded.artifact, MAX_PAYLOAD_CHARS);
  const result = await client.judge({ system, user: userPrompt(payload), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
  return judgeOutcome(result, addedLineIndex(loaded.artifact));
}

/** Exposed for the pair-fixture round-trip test (ACA-0020 requirement 4):
 * load → diff → assert, no judge call. */
export function loadFixtureSuite(): { manifest: ReturnType<typeof validatePairManifest>; cases: Map<string, LoadedPairCase> } {
  const manifestText = readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8');
  const manifest = validatePairManifest(JSON.parse(manifestText), CRITERIA);
  return { manifest, cases: new Map(manifest.fixtures.map((fixture: PairFixture) => [fixture.name, loadPairCase(FIXTURES_DIR, fixture)])) };
}
