import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeOutcome, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/context-footprint/judge-io.ts';

const FACTS = { imports: ['src/a.ts'], importedBy: ['src/b.ts', 'src/c.ts'], hunks: '@@ -1 +1 @@', growth: 'grew from 10 to 20 lines' };

test('system prompt embeds the vendored rule text verbatim, never a paraphrase', () => {
  const rule = ruleText();
  assert.ok(rule.includes('smallest practical context footprint'));
  assert.ok(systemPrompt(rule).includes(rule));
});

test('user prompt carries content, import paths, imported-by paths, hunks, growth', () => {
  const prompt = userPrompt('src/x.ts', 'const x = 1;', FACTS);
  for (const expected of ['src/x.ts', 'const x = 1;', 'src/a.ts', 'src/b.ts', 'src/c.ts', '@@ -1 +1 @@', 'grew from 10 to 20 lines']) {
    assert.ok(prompt.includes(expected), `missing: ${expected}`);
  }
});

test('verdict schema is strict: additionalProperties false, all fields required', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], ['verdict', 'practical_test_answer', 'violations', 'reasoning_summary']);
  const violations = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, Record<string, unknown>>>)['violations']!['items']!;
  assert.equal(violations['additionalProperties'], false);
});

const JUDGED = {
  verdict: 'fail',
  practical_test_answer: 'the file plus all fourteen domains',
  violations: [{ criterion: 'duplicated-context', evidence: 'restates every message type', suggestion: 'compose the sub-unions' }],
  reasoning_summary: 'Enumeration over content.',
};

test('a valid judged verdict maps through and is cacheable', () => {
  const { verdict, cacheable } = judgeOutcome('src/x.ts', { ok: true, verdict: JUDGED });
  assert.equal(cacheable, true);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.violations[0]!.criterion, 'duplicated-context');
  assert.equal(verdict.note, 'Enumeration over content.');
});

test('pass carries no note', () => {
  const { verdict } = judgeOutcome('src/x.ts', { ok: true, verdict: { ...JUDGED, verdict: 'pass', violations: [] } });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.note, undefined);
});

test('transport degradation maps to warn with the note, not cacheable', () => {
  const { verdict, cacheable } = judgeOutcome('src/x.ts', { ok: false, note: 'judge refused (cyber)' });
  assert.equal(cacheable, false);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'judge refused (cyber)']);
});

test('shape violations degrade to warn: bad criterion, bad verdict, fail without evidence', () => {
  const badCriterion = judgeOutcome('x', { ok: true, verdict: { ...JUDGED, violations: [{ criterion: 'vibes', evidence: '', suggestion: '' }] } });
  const badVerdict = judgeOutcome('x', { ok: true, verdict: { ...JUDGED, verdict: 'maybe' } });
  const failNoEvidence = judgeOutcome('x', { ok: true, verdict: { ...JUDGED, violations: [] } });
  for (const { verdict, cacheable } of [badCriterion, badVerdict, failNoEvidence]) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.ok(verdict.note);
  }
});
