// Calibration self-test (ACA-0012): run each fixture repository tree through
// the production artifact → partition → judge → host-policy path and grade
// cumulatively. Always live — the cache is a no-op — so every run exercises
// the prompt as shipped. Trees are loaded through the library's real
// discovery/cascade resolver; a manifest, checksum, or listing error is a
// configuration error (exit 2) before any judge request. If an assertion
// breaks, the prompt is wrong, not the fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import {
  achievedLevel,
  findingsOf,
  matchExpectation,
  qualifies,
  suiteIdentity,
  validateManifest,
  type Expectation,
  type LevelStatus,
  type TreeResolver,
} from './calibration.ts';
import { PROMPT_VERSION, systemPrompt } from './judge-io.ts';
import { CORPUS_ROW, type ConflictVerdict } from './outcome.ts';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: Expectation;
  actual?: { assessment?: string; verdict: string; criteria: string[]; sharedSessions: string[][]; note?: string };
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

function fsResolver(): TreeResolver {
  return {
    listTree(tree) {
      try {
        return readdirSync(join(FIXTURES_DIR, tree), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name).slice(join(FIXTURES_DIR, tree).length + 1).replaceAll('\\', '/'))
          .sort();
      } catch {
        return undefined;
      }
    },
    contentOf(tree, path) {
      try {
        return readFileSync(join(FIXTURES_DIR, tree, ...path.split('/')), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function describe(verdicts: readonly ConflictVerdict[]): string {
  const corpus = verdicts.find((v) => v.file === CORPUS_ROW);
  const findings = findingsOf(verdicts);
  const worst = findings.some((f) => f.verdict === 'fail') ? 'fail' : findings.length > 0 || corpus?.verdict === 'warn' ? 'warn' : 'pass';
  const criteria = findings.map((f) => `${f.criterion}${f.sessionsLoadingBoth.length > 0 ? '(shared)' : '(none)'}`);
  const parts = [criteria.length > 0 ? `[${criteria.join(', ')}]` : '', corpus?.note !== undefined ? `(${corpus.note})` : ''].filter(Boolean);
  return [`${corpus?.assessment ?? 'degraded'}/${worst}`, ...parts].join(' ');
}

function describeExpectation(expect: Expectation): string {
  return [
    `${expect.assessment}/${expect.verdict}`,
    expect.criteriaAnyOf !== undefined ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '',
    expect.sharedSessions !== undefined ? `[shared sessions: ${expect.sharedSessions}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  // Imported lazily to break the index <-> self-test cycle at module load.
  const { judgeCorpus } = await import('./index.ts');
  const manifestText = readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new ConfigError(`self-test manifest: invalid JSON — ${(err as Error).message}`);
  }
  const resolver = fsResolver();
  const manifest = validateManifest(raw, resolver);

  const referenced = manifest.fixtures.flatMap((fixture) =>
    Object.keys(fixture.files)
      .sort()
      .map((path) => resolver.contentOf(fixture.tree, path)!),
  );
  const fixtureSuite = suiteIdentity(PROMPT_VERSION, systemPrompt(), manifestText, referenced);

  const levelIds = manifest.levels.map((level) => level.id);
  const levelStatus = new Map<string, LevelStatus>();
  const reports = new Map<string, FixtureReport>();
  const lines: string[] = [`self-test (${PROMPT_VERSION}, suite ${fixtureSuite}) via ${client.provider}/${client.model}`];
  const liveCache = { get: () => undefined, set: () => undefined };

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
    for (const fixture of fixtures) {
      // Each tree is judged through the production path with no exclusions
      // (fixture trees are complete corpora) and no caching (always live).
      const verdicts = await judgeCorpus(join(FIXTURES_DIR, fixture.tree, 'repo'), client, liveCache, []);
      const ok = matchExpectation(fixture.expect, verdicts);
      if (!ok) passed = false;
      const corpus = verdicts.find((v) => v.file === CORPUS_ROW);
      const findings = findingsOf(verdicts);
      reports.set(fixture.name, {
        name: fixture.name,
        level: id,
        status: ok ? 'ok' : 'miss',
        expected: fixture.expect,
        actual: {
          ...(corpus?.assessment !== undefined ? { assessment: corpus.assessment } : {}),
          verdict: findings.some((f) => f.verdict === 'fail') ? 'fail' : findings.length > 0 || corpus?.verdict === 'warn' ? 'warn' : 'pass',
          criteria: findings.map((f) => f.criterion),
          sharedSessions: findings.map((f) => [...f.sessionsLoadingBoth]),
          ...(corpus?.note !== undefined ? { note: corpus.note } : {}),
        },
      });
      lines.push(`${ok ? 'ok' : 'MISS'} [${id}] ${fixture.name}: got ${describe(verdicts)}, expected ${describeExpectation(fixture.expect)}`);
    }
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
