// Calibration self-test (ACA-0012): judge the golden instruction fixtures
// level by level and grade cumulatively. Always live — never cached — so
// every run exercises the prompt as shipped. If an assertion breaks, the
// prompt is wrong, not the fixture. The foundation pair pins "length is not
// the signal": a padded file fails while a similar-length dense
// tribal-knowledge file passes. Levels run in manifest order through the
// production pool; once a level fails, higher levels are skipped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import { defaultEstimator, DEFAULT_ESTIMATOR_ID, type InstructionFile } from '../../corpora/instructions/index.ts';
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
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA, type AgentContextCostVerdict, type LoadSetSummary } from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);
const DOCS = 'https://code.claude.com/docs/en/memory';

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: Expectation;
  actual?: { assessment?: string; verdict: string; criteria: string[]; actions: string[]; note?: string };
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

/** Fixtures are judged as root Claude project memory: one verified
 * session-start binding and one synthetic load set, so the exam isolates the
 * value-density judgment from cascade mechanics. */
function sourceOf(fixture: CalibrationFixture, content: string): { source: InstructionFile; sets: LoadSetSummary[]; bytes: number } {
  const tokens = { count: defaultEstimator.estimate(content), estimated: true as const, estimator: DEFAULT_ESTIMATOR_ID };
  const source: InstructionFile = {
    locator: `repo:${fixture.file}`,
    origin: 'repo',
    path: fixture.file,
    content,
    contentKind: 'markdown',
    fullFile: tokens,
    bindings: [
      {
        tool: 'claude-code',
        profile: 'claude-local',
        convention: 'claude-code/memory',
        scope: { kind: 'root' },
        activation: 'session-start',
        cadence: 'per-session',
        charged: { kind: 'comment-stripped', text: content, tokens },
        order: { kind: 'ordered', rule: 'root project memory loads at launch', rank: 1000 },
        conflict: 'later-overrides',
        semantics: { status: 'verified', source: DOCS, verifiedAt: '2026-08-05' },
      },
    ],
  };
  const sets: LoadSetSummary[] = [
    { id: 'claude-local@.', baselineTokens: tokens.count, conditionalTokens: 0, complete: true },
  ];
  return { source, sets, bytes: new TextEncoder().encode(content).length };
}

function describe(verdict: AgentContextCostVerdict): string {
  const criteria = (verdict.findings ?? []).map((f) => f.criterion);
  const parts = [criteria.length ? `[${criteria.join(', ')}]` : '', verdict.note ? `(${verdict.note})` : ''].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

function describeExpectation(expect: Expectation): string {
  return [
    `${expect.assessment}/${expect.verdict}`,
    expect.criteriaAnyOf ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '',
    expect.actionsAnyOf ? `[action any of: ${expect.actionsAnyOf.join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  const system = systemPrompt();
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
  const fixtureSuite = suiteIdentity(PROMPT_VERSION, system, manifestText, referenced);

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
      const { source, sets, bytes } = sourceOf(fixture, contentOf(fixture.content)!);
      const result = await client.judge({ system, user: userPrompt(source, sets, bytes), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return judgeOutcome(source, result, defaultEstimator).verdict;
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
          criteria: (verdict.findings ?? []).map((f) => f.criterion),
          actions: (verdict.findings ?? []).map((f) => f.action),
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
