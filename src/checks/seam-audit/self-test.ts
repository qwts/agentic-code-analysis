// Calibration self-test (ACA-0004 D8 pattern, comparative per ACA-0013,
// graded per ACA-0012): judge the golden fixture comparisons level by level
// and grade cumulatively. Always live — never cached — so every run exercises
// the prompt as shipped. If an assertion breaks, the prompt is wrong, not the
// fixture. Levels run in manifest order through the production pool; once a
// level fails, higher levels are skipped — they cannot repair a lower miss
// and would only add spend.
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
import { snapshotOf, type Comparison } from './comparison.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA, type SeamAuditVerdict } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: Expectation;
  actual?: { assessment?: string; verdict: string; blocking: string[]; residual: string[]; note?: string };
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

// Dependencies and candidates derive from the fixture content for real, via
// the production evidence extraction.
function comparisonOf(fixture: CalibrationFixture, contentOf: (file: string) => string | undefined): Comparison {
  const head = snapshotOf(fixture.file, contentOf(fixture.head.content)!);
  if (fixture.kind === 'new' || !fixture.base) return { kind: 'new', head };
  return { kind: 'legacy', base: snapshotOf(fixture.file, contentOf(fixture.base.content)!), head };
}

const names = (verdict: SeamAuditVerdict, changes: (change: string) => boolean): string[] =>
  (verdict.testabilityFootprint ?? []).filter((item) => changes(item.change)).map((item) => `${item.dependency} (${item.criterion})`);

function describe(verdict: SeamAuditVerdict): string {
  const blocking = names(verdict, (change) => change !== 'pre-existing');
  const residual = names(verdict, (change) => change === 'pre-existing');
  const parts = [
    blocking.length ? `[${blocking.join(', ')}]` : '',
    residual.length ? `[residual: ${residual.join(', ')}]` : '',
    verdict.note ? `(${verdict.note})` : '',
  ].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

function describeExpectation(expect: Expectation): string {
  const list = (entries: { dependency: string; criterion?: string }[] | undefined): string =>
    entries ? entries.map((entry) => (entry.criterion ? `${entry.dependency} (${entry.criterion})` : entry.dependency)).join(', ') : '';
  return [
    `${expect.assessment}/${expect.verdict}`,
    expect.blockingAllOf ? `[all of: ${list(expect.blockingAllOf)}]` : '',
    expect.residualAllOf ? `[residual all of: ${list(expect.residualAllOf)}]` : '',
    expect.emptyFootprint ? '[empty footprint]' : '',
  ]
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

  const referenced = manifest.fixtures.flatMap((fixture) => [fixture.head, ...(fixture.base ? [fixture.base] : [])].map((side) => contentOf(side.content)!));
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
      const comparison = comparisonOf(fixture, contentOf);
      const result = await client.judge({ system, user: userPrompt(comparison), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return judgeOutcome(comparison, result).verdict;
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
          blocking: names(verdict, (change) => change !== 'pre-existing'),
          residual: names(verdict, (change) => change === 'pre-existing'),
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
