// Calibration self-test (ACA-0004 D8): judge the golden fixtures, assert the
// manifest's expected verdicts. Always live — never cached — so every run
// exercises the prompt as shipped. If an assertion breaks, the prompt is
// wrong, not the fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import { importsOf, type FileFacts } from './derive.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from './judge-io.ts';

interface Fixture {
  name: string;
  file: string;
  content: string;
  importedBy: string[];
  growth: string;
  expect: { verdict: 'pass' | 'warn' | 'fail'; criteriaAnyOf?: string[] };
}

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

function loadFixtures(): Fixture[] {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8')) as Fixture[];
  return manifest;
}

export async function selfTest(client: JudgeClient): Promise<SelfTestResult> {
  const system = systemPrompt(ruleText());
  const lines: string[] = [`self-test (${PROMPT_VERSION}) via ${client.provider}/${client.model}`];
  let passed = true;
  const results = await Promise.all(
    loadFixtures().map(async (fixture) => {
      const content = readFileSync(fileURLToPath(new URL(fixture.content, FIXTURES_DIR)), 'utf8');
      // Imports derive from the fixture content for real; imported-by and
      // growth cannot (fixtures live outside any repo) and come from the manifest.
      const facts: FileFacts = {
        imports: importsOf(fixture.file, content),
        importedBy: fixture.importedBy,
        hunks: '',
        growth: fixture.growth,
      };
      const result = await client.judge({ system, user: userPrompt(fixture.file, content, facts), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return { fixture, outcome: judgeOutcome(fixture.file, result) };
    }),
  );
  for (const { fixture, outcome } of results) {
    const { verdict } = outcome;
    const criteria = verdict.violations.map((v) => v.criterion);
    const verdictOk = verdict.verdict === fixture.expect.verdict;
    const criteriaOk = !fixture.expect.criteriaAnyOf || criteria.some((c) => fixture.expect.criteriaAnyOf!.includes(c));
    const ok = verdictOk && criteriaOk;
    if (!ok) passed = false;
    const got = `${verdict.verdict}${criteria.length ? ` [${criteria.join(', ')}]` : ''}${verdict.note ? ` (${verdict.note})` : ''}`;
    const want = `${fixture.expect.verdict}${fixture.expect.criteriaAnyOf ? ` [any of: ${fixture.expect.criteriaAnyOf.join(', ')}]` : ''}`;
    lines.push(`${ok ? 'ok' : 'MISS'} ${fixture.name}: got ${got}, expected ${want}`);
  }
  return { passed, lines };
}
