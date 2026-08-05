import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeOutcome, rubricText, systemPrompt, userPrompt } from '../src/checks/test-honesty/judge-io.ts';
import type { Evidence } from '../src/checks/test-honesty/unit-context.ts';

const EVIDENCE: Evidence = {
  file: 'tests/adder.test.ts',
  content: `test('add sums', () => {});`,
  mode: 'unit-exports',
  units: [{ path: 'src/adder.ts', exports: ['export function add(a: number, b: number): number {'] }],
  snapshots: [],
  unavailable: [],
};

const FINDING = { test: 'add sums', criterion: 'tautology', evidence: 'compares the unit with itself', meaningful_assertion: 'a fixed expected sum' };
const HONEST = { assessment: 'honest', findings: [], reasoning_summary: 'discriminating' };
const DISHONEST = { assessment: 'dishonest', findings: [FINDING], reasoning_summary: 'cannot fail' };

test('honest maps to pass and dishonest to fail with the renderer mapping', () => {
  const pass = judgeOutcome(EVIDENCE, { ok: true, verdict: HONEST });
  assert.equal(pass.verdict.verdict, 'pass');
  assert.equal(pass.cacheable, true);
  assert.deepEqual(pass.verdict.context, { mode: 'unit-exports', sources: ['src/adder.ts'] });

  const fail = judgeOutcome(EVIDENCE, { ok: true, verdict: DISHONEST });
  assert.equal(fail.verdict.verdict, 'fail');
  assert.equal(fail.cacheable, true);
  assert.deepEqual(fail.verdict.violations, [
    { criterion: 'tautology', evidence: 'add sums: compares the unit with itself', suggestion: 'a fixed expected sum' },
  ]);
  assert.deepEqual(fail.verdict.findings, [FINDING], 'the test name survives as structured data');
});

test('a judged uncertain is a cacheable warn; degradations are not cacheable', () => {
  const uncertain = judgeOutcome(EVIDENCE, { ok: true, verdict: { ...HONEST, assessment: 'uncertain' } });
  assert.equal(uncertain.verdict.verdict, 'warn');
  assert.equal(uncertain.cacheable, true);

  const degradations = [
    { ok: false as const, note: 'api error: overloaded' },
    { ok: true as const, verdict: { bogus: true } },
    { ok: true as const, verdict: { ...DISHONEST, findings: [{ ...FINDING, criterion: 'made-up' }] } },
    { ok: true as const, verdict: { ...DISHONEST, findings: [{ ...FINDING, test: '' }] } },
    { ok: true as const, verdict: { ...DISHONEST, findings: [{ ...FINDING, evidence: '' }] } },
    { ok: true as const, verdict: { ...DISHONEST, findings: [{ ...FINDING, meaningful_assertion: ' ' }] } },
    { ok: true as const, verdict: { ...DISHONEST, findings: [] } },
    { ok: true as const, verdict: { ...HONEST, findings: [FINDING] } },
  ];
  for (const result of degradations) {
    const outcome = judgeOutcome(EVIDENCE, result);
    assert.equal(outcome.verdict.verdict, 'warn');
    assert.equal(outcome.cacheable, false, `must retry: ${JSON.stringify(result)}`);
  }
});

test('an unresolved external snapshot cannot support an unreviewable-snapshot fail', () => {
  const snapshotFinding = { ...FINDING, criterion: 'unreviewable-snapshot' };
  const unresolved: Evidence = { ...EVIDENCE, unavailable: ['snapshot unavailable: tests/__snapshots__/adder.test.ts.snap'] };
  const guarded = judgeOutcome(unresolved, { ok: true, verdict: { ...DISHONEST, findings: [snapshotFinding] } });
  assert.equal(guarded.verdict.verdict, 'warn');
  assert.equal(guarded.cacheable, true, 'the guard describes the evidence pair and caches');

  // Resolved snapshot content: the same finding is a legitimate fail.
  const resolved: Evidence = { ...EVIDENCE, snapshots: [{ path: 'tests/__snapshots__/adder.test.ts.snap', content: 'blob' }] };
  assert.equal(judgeOutcome(resolved, { ok: true, verdict: { ...DISHONEST, findings: [snapshotFinding] } }).verdict.verdict, 'fail');

  // A mixed dishonest still fails: the other criterion stands on its own.
  const mixed = judgeOutcome(unresolved, { ok: true, verdict: { ...DISHONEST, findings: [snapshotFinding, FINDING] } });
  assert.equal(mixed.verdict.verdict, 'fail');
});

test('prompts embed the rubric verbatim and the evidence with its markers', () => {
  const rubric = rubricText();
  assert.ok(systemPrompt(rubric).includes(rubric), 'the rubric is embedded, never paraphrased');
  const user = userPrompt({ ...EVIDENCE, unavailable: ['unit exports unavailable'] });
  assert.ok(user.includes('Test file: tests/adder.test.ts'));
  assert.ok(user.includes('Unit under test: src/adder.ts'));
  assert.ok(user.includes('unit exports unavailable'));
  assert.ok(user.includes(EVIDENCE.content));
});
