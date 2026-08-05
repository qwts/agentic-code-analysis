// Calibration self-test (ACA-0004 D8 pattern, graded per ACA-0012): judge
// the golden fixture test files level by level and grade cumulatively.
// Always live — never cached — so every run exercises the prompt as shipped.
// If an assertion breaks, the prompt is wrong, not the fixture. Levels run
// in manifest order through the production pool; once a level fails, higher
// levels are skipped — they cannot repair a lower miss and would only add
// spend.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import {
  achievedLevel,
  matchExpectation,
  qualifies,
  suiteIdentity,
  validateManifest,
  type CalibrationFixture,
  type Expectation,
  type LevelStatus,
} from './calibration.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA, type TestHonestyVerdict } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import type { Evidence } from './unit-context.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: Expectation;
  actual?: { assessment?: string; verdict: string; criteria: string[]; note?: string };
}

/** The machine-readable qualification record (ACA-0012). Carries no fixture
 * contents and no prompts — identity, grades, and per-fixture outcomes only. */
export interface SelfTestReport {
  promptVersion: string;
  fixtureSuite: string;
  requiredLevel: string;
  achievedLevel: string | null;
  qualified: boolean;
  levels: { id: string; status: LevelStatus }[];
  fixtures: FixtureReport[];
}

/** Check-local structural subtype — the registry's SelfTestResult stays
 * narrow; the dispatcher duck-types `report` for --json. */
export interface GradedSelfTestResult extends SelfTestResult {
  report: SelfTestReport;
}

// Fixtures live outside any repo, so companion context comes from the
// manifest instead of unit-context resolution; the evidence shape is
// identical to a live run's.
function evidenceOf(fixture: CalibrationFixture, contentOf: (file: string) => string | undefined): Evidence {
  return {
    file: fixture.file,
    content: contentOf(fixture.content)!,
    mode: fixture.units.length > 0 ? 'unit-exports' : 'test-only',
    units: fixture.units,
    snapshots: fixture.snapshots,
    unavailable: fixture.unavailable,
  };
}

function describe(verdict: TestHonestyVerdict): string {
  const criteria = (verdict.findings ?? []).map((finding) => finding.criterion);
  const parts = [criteria.length ? `[${criteria.join(', ')}]` : '', verdict.note ? `(${verdict.note})` : ''].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

function describeExpectation(expect: Expectation): string {
  return [`${expect.assessment}/${expect.verdict}`, expect.criteriaAnyOf ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '']
    .filter(Boolean)
    .join(' ');
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);

  const manifestText = readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new ConfigError(`self-test manifest: invalid JSON — ${(err as Error).message}`);
  }
  const contents = new Map<string, string>();
  const contentOf = (file: string): string | undefined => {
    if (!contents.has(file)) {
      try {
        contents.set(file, readFileSync(fileURLToPath(new URL(file, FIXTURES_DIR)), 'utf8'));
      } catch {
        return undefined;
      }
    }
    return contents.get(file);
  };
  const manifest = validateManifest(raw, contentOf);

  const referenced = manifest.fixtures.map((fixture) => contentOf(fixture.content)!);
  const fixtureSuite = suiteIdentity(PROMPT_VERSION, rubric, manifestText, referenced);

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
    const verdicts = await mapPool(fixtures, CONCURRENCY, async (fixture) => {
      const evidence = evidenceOf(fixture, contentOf);
      const result = await client.judge({ system, user: userPrompt(evidence), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return judgeOutcome(evidence, result).verdict;
    });
    let passed = true;
    fixtures.forEach((fixture, index) => {
      const verdict = verdicts[index]!;
      const ok = matchExpectation(fixture.expect, verdict);
      if (!ok) passed = false;
      reports.set(fixture.name, {
        name: fixture.name,
        level: id,
        status: ok ? 'ok' : 'miss',
        expected: fixture.expect,
        actual: {
          ...(verdict.assessment !== undefined ? { assessment: verdict.assessment } : {}),
          verdict: verdict.verdict,
          criteria: (verdict.findings ?? []).map((finding) => finding.criterion),
          ...(verdict.note !== undefined ? { note: verdict.note } : {}),
        },
      });
      lines.push(`${ok ? 'ok' : 'MISS'} [${id}] ${fixture.name}: got ${describe(verdict)}, expected ${describeExpectation(fixture.expect)}`);
    });
    levelStatus.set(id, passed ? 'passed' : 'failed');
    if (!passed) stopped = true;
  }

  const achieved = achievedLevel(levelIds, levelStatus);
  const qualified = qualifies(levelIds, achieved, manifest.requiredLevel);
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
