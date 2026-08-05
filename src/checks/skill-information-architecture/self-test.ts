// Live uncached package-tree calibration. Levels are cumulative and stop after
// the first miss; tree integrity and the same-token ordering invariant are
// checked before any judge request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JudgeClient } from '../../core/judge-client.ts';
import { ConfigError } from '../../core/config.ts';
import type { SelfTestResult } from '../registry.ts';
import { defaultEstimator, discoverInstructionCorpus } from '../../corpora/instructions/index.ts';
import { buildPayload } from './payload.ts';
import { buildSkillPackages } from './skill-topology.ts';
import { loadTaskEvidence } from './task-evidence.ts';
import { MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA } from './judge-io.ts';
import { judgeOutcome } from './outcome.ts';
import { achievedLevel, matchExpectation, suiteIdentity, validateManifest, type CalibrationFixture, type FixtureExpectation, type LevelStatus } from './calibration.ts';
import { mapPool } from './pool.ts';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: FixtureExpectation;
  actual?: { assessment?: string; verdict: string; criteria: string[]; actions: string[]; note?: string };
}

export interface SelfTestReport {
  promptVersion: string;
  fixtureSuite: string;
  requiredLevel: string;
  achievedLevel: string | null;
  qualified: boolean;
  levels: { id: string; status: LevelStatus }[];
  fixtures: FixtureReport[];
}

interface GradedSelfTestResult extends SelfTestResult {
  report: SelfTestReport;
}

async function packageOf(fixture: CalibrationFixture) {
  const root = join(FIXTURES_DIR, fixture.root);
  const corpus = await discoverInstructionCorpus({ repoRoot: root });
  const packages = buildSkillPackages(corpus);
  if (packages.length !== 1) throw new ConfigError(`self-test fixture ${fixture.name} must expose exactly one corpus-bound package`);
  const pkg = packages[0]!;
  const evidence = loadTaskEvidence(root, [pkg]).get(pkg.packageId)!;
  return { pkg, evidence, payload: buildPayload(pkg, evidence) };
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  const manifestText = readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (error) {
    throw new ConfigError(`self-test manifest: invalid JSON — ${(error as Error).message}`);
  }
  const manifest = validateManifest(raw, FIXTURES_DIR);
  const prompt = systemPrompt();
  const contents = manifest.fixtures.flatMap((fixture) => fixture.files.map((file) => readFileSync(join(FIXTURES_DIR, fixture.root, file.path))));
  const fixtureSuite = suiteIdentity(PROMPT_VERSION, prompt, manifestText, contents);
  const prepared = new Map<string, Awaited<ReturnType<typeof packageOf>>>();
  for (const fixture of manifest.fixtures) prepared.set(fixture.name, await packageOf(fixture));
  for (const fixture of manifest.fixtures) {
    if (fixture.sameBodyTokensAs !== undefined) {
      const left = defaultEstimator.estimate(prepared.get(fixture.name)!.pkg.body);
      const right = defaultEstimator.estimate(prepared.get(fixture.sameBodyTokensAs)!.pkg.body);
      if (left !== right) throw new ConfigError(`calibration same-token ordering invariant failed: ${fixture.name} (${left}) != ${fixture.sameBodyTokensAs} (${right})`);
    }
  }

  const ids = manifest.levels.map((level) => level.id);
  const status = new Map<string, LevelStatus>();
  const reports = new Map<string, FixtureReport>();
  const lines = [`self-test (${PROMPT_VERSION}, suite ${fixtureSuite}) via ${client.provider}/${client.model}`];
  let stopped = false;
  for (const id of ids) {
    const fixtures = manifest.fixtures.filter((fixture) => fixture.level === id);
    if (stopped) {
      status.set(id, 'skipped');
      for (const fixture of fixtures) reports.set(fixture.name, { name: fixture.name, level: id, status: 'skipped', expected: fixture.expect });
      continue;
    }
    const verdicts = await mapPool(fixtures, 3, async (fixture) => {
      const { pkg, evidence, payload } = prepared.get(fixture.name)!;
      const result = await client.judge({ system: prompt, user: userPrompt(payload), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return judgeOutcome(pkg, evidence, payload, result, defaultEstimator).verdict;
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
          actions: (verdict.findings ?? []).map((finding) => finding.action),
          ...(verdict.note !== undefined ? { note: verdict.note } : {}),
        },
      });
      lines.push(`${ok ? 'ok' : 'MISS'} [${id}] ${fixture.name}: ${verdict.assessment ?? 'degraded'}/${verdict.verdict}`);
    });
    status.set(id, passed ? 'passed' : 'failed');
    if (!passed) stopped = true;
  }
  const achieved = achievedLevel(ids, status);
  const qualified = achieved !== null && ids.indexOf(achieved) >= ids.indexOf(manifest.requiredLevel);
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
      levels: ids.map((id) => ({ id, status: status.get(id)! })),
      fixtures: manifest.fixtures.map((fixture) => reports.get(fixture.name)!),
    },
  };
}
