import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotOf, type Comparison } from '../src/checks/seam-audit/comparison.ts';
import {
  judgeOutcome,
  rubricText,
  systemPrompt,
  userPrompt,
  VERDICT_SCHEMA,
  type SeamDependency,
} from '../src/checks/seam-audit/judge-io.ts';

const HEAD = snapshotOf('src/x.ts', `import { port } from './port.ts';\nexport const run = () => port();\n`);
const BASE = snapshotOf('src/x.ts', 'export const run = () => Date.now();\n');

const NEW: Comparison = { kind: 'new', head: HEAD };
const LEGACY: Comparison = { kind: 'legacy', base: BASE, head: HEAD };

function item(overrides: Partial<SeamDependency> = {}): SeamDependency {
  return {
    dependency: 'Date.now',
    criterion: 'ambient-state',
    change: 'new',
    access_point: 'run()',
    evidence: 'calls Date.now() directly',
    test_patch: 'the global Date object',
    suggested_seam: 'accept a Clock port',
    ...overrides,
  };
}

function reply(assessment: string, items: SeamDependency[] = [], evidence = 'specific before-to-after observation') {
  return {
    ok: true as const,
    verdict: {
      assessment,
      comparison_evidence: evidence,
      dependencies_without_seams: items,
      reasoning_summary: 'Two or three sentences.',
    },
  };
}

test('the schema is strict: closed objects, all fields required, closed enums', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], ['assessment', 'comparison_evidence', 'dependencies_without_seams', 'reasoning_summary']);
  const items = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, unknown>>)['dependencies_without_seams']!['items'] as Record<string, unknown>;
  assert.equal(items['additionalProperties'], false);
  assert.deepEqual(items['required'], ['dependency', 'criterion', 'change', 'access_point', 'evidence', 'test_patch', 'suggested_seam']);
});

test('prompts embed the rubric verbatim and the per-snapshot evidence', () => {
  assert.ok(systemPrompt(rubricText()).includes('# Rubric: testable seams'));
  const user = userPrompt(LEGACY);
  assert.match(user, /Kind: legacy/);
  assert.match(user, /Head dependencies \(specifiers\):\nsrc\/port\.ts/);
  assert.match(user, /Base ambient-access candidates[^\n]*:\nDate \(clock\)/);
  assert.match(user, /<base-content>/);
  assert.match(userPrompt(NEW), /Kind: new/);
});

test('new-compliant with an empty footprint passes; naming an item degrades it', () => {
  const good = judgeOutcome(NEW, reply('new-compliant'));
  assert.equal(good.verdict.verdict, 'pass');
  assert.equal(good.verdict.source, 'judge');
  assert.deepEqual(good.verdict.testabilityFootprint, []);
  assert.equal(good.cacheable, true);

  const bad = judgeOutcome(NEW, reply('new-compliant', [item()]));
  assert.equal(bad.verdict.verdict, 'warn');
  assert.equal(bad.cacheable, false);
});

test('new-violating fails on the enumerated footprint; an empty one degrades', () => {
  const { verdict, cacheable } = judgeOutcome(NEW, reply('new-violating', [item()]));
  assert.equal(verdict.verdict, 'fail');
  assert.equal(cacheable, true);
  assert.equal(verdict.violations.length, 1);
  assert.match(verdict.violations[0]!.evidence, /Date\.now at run\(\)/);
  assert.match(verdict.violations[0]!.evidence, /must patch the global Date object/);
  assert.equal(verdict.violations[0]!.suggestion, 'accept a Clock port');

  assert.equal(judgeOutcome(NEW, reply('new-violating')).cacheable, false);
});

test('improved/held pass and retain pre-existing items as residual debt', () => {
  for (const assessment of ['improved', 'held']) {
    const residual = item({ change: 'pre-existing' });
    const { verdict, cacheable } = judgeOutcome(LEGACY, reply(assessment, [residual]));
    assert.equal(verdict.verdict, 'pass');
    assert.equal(cacheable, true);
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.residualViolations!.length, 1);
    assert.match(verdict.note!, /residual missing seams/);
  }
});

test('regressed fails on introduced/worsened items; pre-existing stay residual', () => {
  const { verdict } = judgeOutcome(LEGACY, reply('regressed', [item({ change: 'introduced' }), item({ dependency: 'fetch', criterion: 'ambient-io', change: 'pre-existing' })]));
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.residualViolations!.length, 1);
  assert.equal(verdict.testabilityFootprint!.length, 2);
});

test('kind/assessment and kind/change mismatches degrade without caching', () => {
  const cases = [
    judgeOutcome(NEW, reply('regressed', [item({ change: 'new' })])),
    judgeOutcome(LEGACY, reply('held', [item({ change: 'new' })])),
    judgeOutcome(NEW, reply('new-violating', [item({ change: 'introduced' })])),
    judgeOutcome(LEGACY, reply('improved', [item({ change: 'introduced' })])),
    judgeOutcome(LEGACY, reply('regressed', [item({ change: 'pre-existing' })])),
  ];
  for (const { verdict, cacheable } of cases) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
  }
});

test('blank blocking evidence or missing comparison evidence degrades', () => {
  const blankEvidence = judgeOutcome(NEW, reply('new-violating', [item({ evidence: '  ' })]));
  assert.equal(blankEvidence.cacheable, false);
  const blankPatch = judgeOutcome(NEW, reply('new-violating', [item({ test_patch: '' })]));
  assert.equal(blankPatch.cacheable, false);
  const blankComparison = judgeOutcome(LEGACY, reply('regressed', [item({ change: 'introduced' })], '  '));
  assert.equal(blankComparison.cacheable, false);
});

test('uncertain is a cacheable warn about the pair; transport and schema failures are not cacheable', () => {
  const uncertain = judgeOutcome(NEW, reply('uncertain'));
  assert.equal(uncertain.verdict.verdict, 'warn');
  assert.equal(uncertain.cacheable, true);

  const transport = judgeOutcome(NEW, { ok: false, note: 'api error: overloaded' });
  assert.equal(transport.verdict.verdict, 'warn');
  assert.equal(transport.cacheable, false);

  const malformed = judgeOutcome(NEW, { ok: true, verdict: { assessment: 'new-compliant' } });
  assert.equal(malformed.cacheable, false);
});

test('a rename carries the base identity on the verdict', () => {
  const renamed: Comparison = { kind: 'legacy', base: snapshotOf('src/old.ts', BASE.content), head: HEAD };
  const { verdict } = judgeOutcome(renamed, reply('held'));
  assert.equal(verdict.basePath, 'src/old.ts');
  assert.equal(verdict.file, 'src/x.ts');
});
