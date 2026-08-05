// Calibration self-test (ACA-0004 D8, comparative cases per ACA-0013): judge
// the golden fixture comparisons, assert the manifest's expected assessment,
// effective verdict, and criteria. Always live — never cached — so every run
// exercises the prompt as shipped. If an assertion breaks, the prompt is
// wrong, not the fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';
import { importsOf } from './import-graph.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA, type SingleResponsibilityVerdict } from './judge-io.ts';

interface FixtureSide {
  content: string;
  importedBy: string[];
}

interface Fixture {
  name: string;
  kind: 'new' | 'legacy';
  file: string;
  head: FixtureSide;
  base?: FixtureSide;
  growth: string;
  expect: {
    assessment: string;
    verdict: 'pass' | 'warn' | 'fail';
    criteriaAnyOf?: string[];
    residualCriteriaAnyOf?: string[];
  };
}

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8')) as Fixture[];
}

// Imports derive from the fixture content for real; imported-by and growth
// cannot (fixtures live outside any repo) and come from the manifest.
function snapshot(path: string, side: FixtureSide): Snapshot {
  const content = readFileSync(fileURLToPath(new URL(side.content, FIXTURES_DIR)), 'utf8');
  return { path, content, imports: importsOf(path, content), importedBy: side.importedBy };
}

function comparisonOf(fixture: Fixture): Comparison {
  const head = snapshot(fixture.file, fixture.head);
  if (fixture.kind === 'new' || !fixture.base) return { kind: 'new', head, growth: fixture.growth };
  return { kind: 'legacy', base: snapshot(fixture.file, fixture.base), head, growth: fixture.growth };
}

function describe(verdict: SingleResponsibilityVerdict): string {
  const criteria = verdict.violations.map((v) => v.criterion);
  const residuals = (verdict.residualViolations ?? []).map((v) => v.criterion);
  const parts = [
    criteria.length ? `[${criteria.join(', ')}]` : '',
    residuals.length ? `[residual: ${residuals.join(', ')}]` : '',
    verdict.note ? `(${verdict.note})` : '',
  ].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

export async function selfTest(client: JudgeClient): Promise<SelfTestResult> {
  const system = systemPrompt(ruleText());
  const lines: string[] = [`self-test (${PROMPT_VERSION}) via ${client.provider}/${client.model}`];
  let passed = true;
  const results = await Promise.all(
    loadFixtures().map(async (fixture) => {
      const comparison = comparisonOf(fixture);
      const result = await client.judge({ system, user: userPrompt(comparison), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return { fixture, outcome: judgeOutcome(comparison, result) };
    }),
  );
  for (const { fixture, outcome } of results) {
    const { verdict } = outcome;
    const expect = fixture.expect;
    const criteria = verdict.violations.map((v) => v.criterion);
    const residuals = (verdict.residualViolations ?? []).map((v) => v.criterion);
    const ok =
      verdict.assessment === expect.assessment &&
      verdict.verdict === expect.verdict &&
      (!expect.criteriaAnyOf || criteria.some((c) => expect.criteriaAnyOf!.includes(c))) &&
      (!expect.residualCriteriaAnyOf || residuals.some((c) => expect.residualCriteriaAnyOf!.includes(c)));
    if (!ok) passed = false;
    const want = [
      `${expect.assessment}/${expect.verdict}`,
      expect.criteriaAnyOf ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '',
      expect.residualCriteriaAnyOf ? `[residual any of: ${expect.residualCriteriaAnyOf.join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`${ok ? 'ok' : 'MISS'} ${fixture.name}: got ${describe(verdict)}, expected ${want}`);
  }
  return { passed, lines };
}
