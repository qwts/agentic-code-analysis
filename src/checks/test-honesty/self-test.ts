// Calibration self-test (ACA-0004 D8 pattern): judge the golden fixture
// test files, assert the manifest's expected assessment, effective verdict,
// criterion, named test, and meaningful-assertion text. Always live — never
// cached — so every run exercises the prompt as shipped. If an assertion
// breaks, the prompt is wrong, not the fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA, type TestHonestyVerdict } from './judge-io.ts';
import type { Evidence, SnapshotContext, UnitContext } from './unit-context.ts';

interface Fixture {
  name: string;
  file: string;
  content: string;
  units: UnitContext[];
  snapshots: SnapshotContext[];
  unavailable: string[];
  expect: {
    assessment: string;
    verdict: 'pass' | 'warn' | 'fail';
    criteriaAnyOf?: string[];
    testNameIncludes?: string;
  };
}

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8')) as Fixture[];
}

// Fixtures live outside any repo, so companion context comes from the
// manifest instead of unit-context resolution; the evidence shape is
// identical to a live run's.
function evidenceOf(fixture: Fixture): Evidence {
  return {
    file: fixture.file,
    content: readFileSync(fileURLToPath(new URL(fixture.content, FIXTURES_DIR)), 'utf8'),
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

export async function selfTest(client: JudgeClient): Promise<SelfTestResult> {
  const system = systemPrompt(rubricText());
  const lines: string[] = [`self-test (${PROMPT_VERSION}) via ${client.provider}/${client.model}`];
  let passed = true;
  const results = await Promise.all(
    loadFixtures().map(async (fixture) => {
      const evidence = evidenceOf(fixture);
      const result = await client.judge({ system, user: userPrompt(evidence), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return { fixture, outcome: judgeOutcome(evidence, result) };
    }),
  );
  for (const { fixture, outcome } of results) {
    const verdict = outcome.verdict;
    const expect = fixture.expect;
    const findings = verdict.findings ?? [];
    const matching = expect.criteriaAnyOf ? findings.filter((finding) => expect.criteriaAnyOf!.includes(finding.criterion)) : findings;
    const ok =
      verdict.assessment === expect.assessment &&
      verdict.verdict === expect.verdict &&
      (!expect.criteriaAnyOf || matching.length > 0) &&
      (!expect.testNameIncludes || matching.some((finding) => finding.test.includes(expect.testNameIncludes!))) &&
      (expect.verdict !== 'fail' || matching.some((finding) => finding.meaningful_assertion.trim() !== ''));
    if (!ok) passed = false;
    const want = [`${expect.assessment}/${expect.verdict}`, expect.criteriaAnyOf ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '']
      .filter(Boolean)
      .join(' ');
    lines.push(`${ok ? 'ok' : 'MISS'} ${fixture.name}: got ${describe(verdict)}, expected ${want}`);
  }
  return { passed, lines };
}
