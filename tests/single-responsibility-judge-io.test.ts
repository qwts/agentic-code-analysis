import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRITERIA as FOOTPRINT_CRITERIA } from '../src/checks/context-footprint/judge-io.ts';
import type { Comparison, Snapshot } from '../src/checks/single-responsibility/comparison.ts';
import { CRITERIA, judgeOutcome, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/single-responsibility/judge-io.ts';

const HEAD: Snapshot = { path: 'src/x.ts', content: 'const head = 1;', imports: ['src/a.ts'], importedBy: ['src/b.ts', 'src/c.ts'] };
const BASE: Snapshot = { path: 'src/x-old.ts', content: 'const base = 1;', imports: ['src/a.ts', 'src/z.ts'], importedBy: ['src/b.ts'] };
const LEGACY: Comparison = { kind: 'legacy', base: BASE, head: HEAD, growth: 'shrank from 10 to 5 lines' };
const NEW: Comparison = { kind: 'new', head: HEAD, growth: 'new file, 5 lines' };

test('system prompt embeds the repo-authored rule text verbatim, never a paraphrase', () => {
  const rule = ruleText();
  assert.ok(rule.includes('one reason to change'));
  assert.ok(systemPrompt(rule).includes(rule));
});

test('criteria are disjoint from the context-footprint criteria — no shared labels', () => {
  for (const criterion of CRITERIA) {
    assert.ok(!(FOOTPRINT_CRITERIA as readonly string[]).includes(criterion), `shared criterion: ${criterion}`);
  }
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
    'before_responsibility',
    'after_responsibility',
    'comparison_evidence',
    'head_violations',
    'reasoning_summary',
  ]);
  const violations = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, Record<string, unknown>>>)['head_violations']!['items']!;
  assert.equal(violations['additionalProperties'], false);
});

const VIOLATION = { criterion: 'multiple-actors', evidence: 'presentation and compliance both own edits', suggestion: 'move retention policy out' };
const JUDGED = {
  assessment: 'regressed',
  before_responsibility: 'the presentation owner alone',
  after_responsibility: 'the presentation owner and the compliance owner',
  comparison_evidence: 'the head adds a retention policy the base did not carry',
  head_violations: [VIOLATION],
  reasoning_summary: 'A second actor moved in.',
};

test('regressed maps to a cacheable fail carrying the evidence and the base path', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: JUDGED });
  assert.equal(cacheable, true);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.assessment, 'regressed');
  assert.equal(verdict.basePath, 'src/x-old.ts');
  assert.equal(verdict.violations[0]!.criterion, 'multiple-actors');
  assert.deepEqual(verdict.residualViolations, []);
  assert.equal(verdict.note, 'A second actor moved in.');
});

test('improved and held pass, retaining head violations as residual debt', () => {
  for (const assessment of ['improved', 'held']) {
    const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment } });
    assert.equal(cacheable, true);
    assert.equal(verdict.verdict, 'pass');
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.residualViolations!.length, 1);
    assert.equal(verdict.note, `responsibility ${assessment}; residual debt`);
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
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'A second actor moved in.']);
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
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [{ criterion: 'mixed-responsibility', evidence: 'e', suggestion: 's' }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, reasoning_summary: 7 } }),
  ];
  for (const { verdict, cacheable } of cases) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.ok(verdict.note);
  }
});
