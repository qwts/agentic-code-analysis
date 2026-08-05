// Calibration self-test (ACA-0004 D8 pattern, comparative cases per
// ACA-0013/0014): judge the golden fixture comparisons and assert the
// manifest's expected assessment, effective verdict, and per-finding
// criterion + symbol — never exact prose or one exact spelling of the
// suggested name. Always live — never cached — and run through the same
// stable-order concurrency-3 pool as the run path. If an assertion breaks,
// the prompt is wrong, not the fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';
import { importsOf } from './derive.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA, type NamingTruthVerdict, type NamingViolation } from './judge-io.ts';
import { mapPool } from './pool.ts';

const CONCURRENCY = 3;

interface FixtureSide {
  content: string;
  importedBy: string[];
}

interface ExpectedFinding {
  criteriaAnyOf: string[];
  symbol: string;
}

interface Fixture {
  name: string;
  kind: 'new' | 'legacy';
  file: string;
  head: FixtureSide;
  base?: FixtureSide;
  expect: {
    assessment: string;
    verdict: 'pass' | 'warn' | 'fail';
    blocking?: ExpectedFinding[];
    residual?: ExpectedFinding[];
  };
}

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8')) as Fixture[];
}

// Imports derive from the fixture content for real; imported-by cannot
// (fixtures live outside any repo) and comes from the manifest.
function snapshot(path: string, side: FixtureSide): Snapshot {
  const content = readFileSync(fileURLToPath(new URL(side.content, FIXTURES_DIR)), 'utf8');
  return { path, content, imports: importsOf(path, content), importedBy: side.importedBy };
}

function comparisonOf(fixture: Fixture): Comparison {
  const head = snapshot(fixture.file, fixture.head);
  if (fixture.kind === 'new' || !fixture.base) return { kind: 'new', head };
  return { kind: 'legacy', base: snapshot(fixture.file, fixture.base), head };
}

/** A judged finding satisfies an expectation when the criterion is one of
 * the allowed labels and the symbol matches (substring either way covers
 * spellings like `getUser` vs `getUser()`). */
function matches(found: NamingViolation[], expected: ExpectedFinding[]): boolean {
  return expected.every((want) =>
    found.some((f) => want.criteriaAnyOf.includes(f.criterion) && (f.symbol.includes(want.symbol) || want.symbol.includes(f.symbol))),
  );
}

function describe(verdict: NamingTruthVerdict): string {
  const label = (v: NamingViolation): string => `${v.criterion}@${v.symbol}`;
  const residuals = verdict.residualViolations ?? [];
  const parts = [
    verdict.violations.length ? `[${verdict.violations.map(label).join(', ')}]` : '',
    residuals.length ? `[residual: ${residuals.map(label).join(', ')}]` : '',
    verdict.note ? `(${verdict.note})` : '',
  ].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

export async function selfTest(client: JudgeClient): Promise<SelfTestResult> {
  const system = systemPrompt(ruleText());
  const lines: string[] = [`self-test (${PROMPT_VERSION}) via ${client.provider}/${client.model}`];
  let passed = true;
  const results = await mapPool(loadFixtures(), CONCURRENCY, async (fixture) => {
    const comparison = comparisonOf(fixture);
    const result = await client.judge({ system, user: userPrompt(comparison), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    return { fixture, outcome: judgeOutcome(comparison, result) };
  });
  for (const { fixture, outcome } of results) {
    const { verdict } = outcome;
    const expect = fixture.expect;
    const ok =
      verdict.assessment === expect.assessment &&
      verdict.verdict === expect.verdict &&
      (!expect.blocking || matches(verdict.violations, expect.blocking)) &&
      (!expect.residual || matches(verdict.residualViolations ?? [], expect.residual));
    if (!ok) passed = false;
    const want = [
      `${expect.assessment}/${expect.verdict}`,
      expect.blocking ? `[${expect.blocking.map((e) => `${e.criteriaAnyOf.join('|')}@${e.symbol}`).join(', ')}]` : '',
      expect.residual ? `[residual: ${expect.residual.map((e) => `${e.criteriaAnyOf.join('|')}@${e.symbol}`).join(', ')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`${ok ? 'ok' : 'MISS'} ${fixture.name}: got ${describe(verdict)}, expected ${want}`);
  }
  return { passed, lines };
}
