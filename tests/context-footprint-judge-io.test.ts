import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comparison, Snapshot } from '../src/checks/context-footprint/comparison.ts';
import { judgeOutcome, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/context-footprint/judge-io.ts';

const HEAD: Snapshot = { path: 'src/x.ts', content: 'const head = 1;', imports: ['src/a.ts'], importedBy: ['src/b.ts', 'src/c.ts'] };
const BASE: Snapshot = { path: 'src/x-old.ts', content: 'const base = 1;', imports: ['src/a.ts', 'src/z.ts'], importedBy: ['src/b.ts'] };
const LEGACY: Comparison = { kind: 'legacy', base: BASE, head: HEAD, growth: 'shrank from 10 to 5 lines' };
const NEW: Comparison = { kind: 'new', head: HEAD, growth: 'new file, 5 lines' };

test('system prompt embeds the vendored rule text verbatim, never a paraphrase', () => {
  const rule = ruleText();
  assert.ok(rule.includes('smallest practical context footprint'));
  assert.ok(systemPrompt(rule).includes(rule));
});

test('legacy prompt carries both snapshots, their graphs, growth, and the rename', () => {
  const prompt = userPrompt(LEGACY);
  for (const expected of [
    'Kind: legacy',
    'Renamed from: src/x-old.ts',
    'shrank from 10 to 5 lines',
    'const base = 1;',
    'const head = 1;',
    'src/z.ts',
    'src/c.ts',
    '<base-content>',
    '<head-content>',
  ]) {
    assert.ok(prompt.includes(expected), `missing: ${expected}`);
  }
});

test('new prompt has no base section and no rename line', () => {
  const prompt = userPrompt(NEW);
  assert.ok(prompt.includes('Kind: new'));
  assert.ok(prompt.includes('const head = 1;'));
  assert.ok(!prompt.includes('<base-content>'));
  assert.ok(!prompt.includes('Renamed from'));
});

test('verdict schema is strict: additionalProperties false, all fields required', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], [
    'assessment',
    'before_practical_test',
    'after_practical_test',
    'comparison_evidence',
    'head_violations',
    'reasoning_summary',
  ]);
  const violations = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, Record<string, unknown>>>)['head_violations']!['items']!;
  assert.equal(violations['additionalProperties'], false);
});

const VIOLATION = { criterion: 'duplicated-context', evidence: 'restates every message type', suggestion: 'compose the sub-unions' };
const JUDGED = {
  assessment: 'regressed',
  before_practical_test: 'this file alone',
  after_practical_test: 'the file plus all fourteen domains',
  comparison_evidence: 'the head re-enumerates what the base composed',
  head_violations: [VIOLATION],
  reasoning_summary: 'Enumeration over content.',
};

test('regressed maps to a cacheable fail carrying the evidence and the base path', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: JUDGED });
  assert.equal(cacheable, true);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.assessment, 'regressed');
  assert.equal(verdict.basePath, 'src/x-old.ts');
  assert.equal(verdict.violations[0]!.criterion, 'duplicated-context');
  assert.deepEqual(verdict.residualViolations, []);
  assert.equal(verdict.note, 'Enumeration over content.');
});

test('improved and held pass, retaining head violations as residual debt', () => {
  for (const assessment of ['improved', 'held']) {
    const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment } });
    assert.equal(cacheable, true);
    assert.equal(verdict.verdict, 'pass');
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.residualViolations!.length, 1);
    assert.equal(verdict.note, `footprint ${assessment}; residual debt`);
  }
});

test('improved with no remaining violations is a clean pass without a note', () => {
  const { verdict } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'improved', head_violations: [] } });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.note, undefined);
  assert.deepEqual(verdict.residualViolations, []);
});

test('basePath is omitted when base and head paths match', () => {
  const samePath: Comparison = { kind: 'legacy', base: { ...BASE, path: 'src/x.ts' }, head: HEAD, growth: 'unchanged at 5 lines' };
  const { verdict } = judgeOutcome(samePath, { ok: true, verdict: { ...JUDGED, assessment: 'held' } });
  assert.equal(verdict.basePath, undefined);
});

test('new-compliant passes clean; new-violating fails on evidence', () => {
  const compliant = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant', head_violations: [] } });
  assert.deepEqual([compliant.verdict.verdict, compliant.cacheable], ['pass', true]);
  const violating = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating' } });
  assert.deepEqual([violating.verdict.verdict, violating.cacheable], ['fail', true]);
});

test('a judged uncertain is a cacheable warn — it describes the pair, not the transport', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'uncertain', head_violations: [] } });
  assert.equal(cacheable, true);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'Enumeration over content.']);
});

test('transport degradation maps to warn with the note, not cacheable', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: false, note: 'judge refused (cyber)' });
  assert.equal(cacheable, false);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'judge refused (cyber)']);
});

test('malformed and kind-incompatible replies degrade to a non-cacheable warn', () => {
  const cases = [
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating' } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'improved' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'vibes' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [] } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating', head_violations: [] } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [null] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [{ criterion: 'duplicated-context', evidence: 5, suggestion: null }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, reasoning_summary: 7 } }),
  ];
  for (const { verdict, cacheable } of cases) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.ok(verdict.note);
  }
});
