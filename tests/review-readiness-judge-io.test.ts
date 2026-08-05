import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeOutcome, type ReviewFinding } from '../src/checks/review-readiness/judge-io.ts';

const ANCHORS = new Map([['src/a.ts', new Set([5, 6])]]);

const FINDING: ReviewFinding = {
  criterion: 'leftover-debug',
  file: 'src/a.ts',
  line: 5,
  evidence: "console.log('HERE', payload) added mid-function with no operational purpose",
  suggestion: 'delete the print',
};

const reply = (assessment: string, findings: unknown[] = [], reasoning_summary = 'summary'): { ok: true; verdict: unknown } => ({
  ok: true,
  verdict: { assessment, findings, reasoning_summary },
});

test('ready with no findings is a cacheable pass', () => {
  const outcome = judgeOutcome(reply('ready'), ANCHORS);
  assert.deepEqual([outcome.verdict, outcome.cacheable, outcome.findings], ['pass', true, []]);
});

test('not-ready with valid anchored findings is a cacheable fail carrying the findings', () => {
  const outcome = judgeOutcome(reply('not-ready', [FINDING]), ANCHORS);
  assert.equal(outcome.verdict, 'fail');
  assert.equal(outcome.cacheable, true);
  assert.deepEqual(outcome.findings, [FINDING]);
  assert.equal(outcome.note, 'summary');
});

test('a judged uncertain is a cacheable warn — it describes the diff, not the transport', () => {
  const outcome = judgeOutcome(reply('uncertain'), ANCHORS);
  assert.deepEqual([outcome.verdict, outcome.cacheable], ['warn', true]);
  assert.equal(outcome.note, 'summary');
});

test('every degradation is a non-cacheable warn, never a crash, dropped finding, or silent pass', () => {
  const degradations: [string, { ok: true; verdict: unknown } | { ok: false; note: string }, RegExp][] = [
    ['transport error', { ok: false, note: 'api error: overloaded' }, /overloaded/],
    ['schema mismatch', { ok: true, verdict: { assessment: 'ready' } }, /schema parse/],
    ['unknown criterion', reply('not-ready', [{ ...FINDING, criterion: 'vibes' }]), /schema parse/],
    ['non-integer line', reply('not-ready', [{ ...FINDING, line: 5.5 }]), /schema parse/],
    ['ready naming findings', reply('ready', [FINDING]), /while naming findings/],
    ['uncertain naming findings', reply('uncertain', [FINDING]), /while naming findings/],
    ['not-ready without findings', reply('not-ready'), /without naming a finding/],
    ['anchor on unknown file', reply('not-ready', [{ ...FINDING, file: 'src/other.ts' }]), /not an added line/],
    ['anchor on a non-added line', reply('not-ready', [{ ...FINDING, line: 4 }]), /not an added line/],
    ['blank evidence', reply('not-ready', [{ ...FINDING, evidence: '  ' }]), /without evidence/],
    ['blank suggestion', reply('not-ready', [{ ...FINDING, suggestion: '' }]), /without evidence/],
  ];
  for (const [label, result, pattern] of degradations) {
    const outcome = judgeOutcome(result, ANCHORS);
    assert.equal(outcome.verdict, 'warn', label);
    assert.equal(outcome.cacheable, false, `${label} must retry next run`);
    assert.deepEqual(outcome.findings, [], label);
    assert.match(outcome.note ?? '', pattern, label);
  }
});
