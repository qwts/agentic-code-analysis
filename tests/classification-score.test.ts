import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classificationTable, scoreReport } from '../scripts/classification-score.ts';

function report(fixtures: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { check: 'test-honesty', provider: 'typesafe', model: 'jev-1', fixtures, ...overrides };
}

test('a single-value expectation scores both axes', () => {
  const row = scoreReport(
    report([{ name: 'discriminating', level: 'foundation', status: 'ok', expected: { assessment: 'honest', verdict: 'pass' }, actual: { assessment: 'honest', verdict: 'pass', criteria: [] } }]),
    'test-honesty',
  );
  assert.equal(row?.assessmentHits, 1);
  assert.equal(row?.verdictHits, 1);
  assert.equal(row?.scored, 1);
  // No label constraint on a pass fixture: the axis is not asked, not passed.
  assert.equal(row?.labelAsked, 0);
});

test('an anyOf expectation accepts any listed value', () => {
  const expected = { assessmentAnyOf: ['drifted', 'uncertain'], verdictAnyOf: ['fail', 'warn'] };
  const hit = scoreReport(report([{ name: 'referent-gone', status: 'ok', expected, actual: { assessment: 'uncertain', verdict: 'warn', criteria: [] } }]), 'doc-drift');
  assert.equal(hit?.assessmentHits, 1);
  assert.equal(hit?.verdictHits, 1);

  const miss = scoreReport(report([{ name: 'referent-gone', status: 'miss', expected, actual: { assessment: 'aligned', verdict: 'pass', criteria: [] } }]), 'doc-drift');
  assert.equal(miss?.assessmentHits, 0);
  assert.equal(miss?.assessmentAsked, 1);
});

test('AnyOf labels need one hit and AllOf labels need every one', () => {
  const anyOf = scoreReport(
    report([{ name: 'f', expected: { criteriaAnyOf: ['tautology', 'asserts-own-mock'] }, actual: { verdict: 'fail', criteria: ['tautology'] } }]),
    'test-honesty',
  );
  assert.equal(anyOf?.labelHits, 1);

  const partial = scoreReport(
    report([{ name: 'f', expected: { criteriaAllOf: ['swallows-error', 'silent-default'] }, actual: { verdict: 'fail', criteria: ['swallows-error'] } }]),
    'failure-posture',
  );
  assert.equal(partial?.labelHits, 0);
  assert.equal(partial?.labelAsked, 1);

  const complete = scoreReport(
    report([{ name: 'f', expected: { criteriaAllOf: ['swallows-error', 'silent-default'] }, actual: { verdict: 'fail', criteria: ['silent-default', 'swallows-error'] } }]),
    'failure-posture',
  );
  assert.equal(complete?.labelHits, 1);
});

test('labels are pooled across the check-specific carriers, including findings', () => {
  const pooled = scoreReport(
    report([
      {
        name: 'f',
        expected: { blockingAllOf: ['hardwired-clock'], residualAllOf: ['hardwired-network'], actionsAnyOf: ['extract'] },
        actual: { verdict: 'fail', blocking: ['hardwired-clock'], residual: ['hardwired-network'], actions: ['extract'] },
      },
    ]),
    'seam-audit',
  );
  assert.equal(pooled?.labelHits, 1);

  const fromFindings = scoreReport(
    report([{ name: 'f', expected: { criteria: ['debris'] }, actual: { verdict: 'fail', findings: [{ criterion: 'debris', file: 'a.ts', line: 3 }] } }]),
    'review-readiness',
  );
  assert.equal(fromFindings?.labelHits, 1);
});

test('nested arrays are not mistaken for labels', () => {
  // agent-rule-conflict carries sharedSessions as string[][]; treating it as a
  // label set would invent a constraint the fixture never stated.
  const row = scoreReport(
    report([{ name: 'f', expected: { criteriaAnyOf: ['contradiction'], sharedSessions: [['a', 'b']] }, actual: { verdict: 'fail', criteria: ['contradiction'], sharedSessions: [['a', 'b']] } }]),
    'agent-rule-conflict',
  );
  assert.equal(row?.labelAsked, 1);
  assert.equal(row?.labelHits, 1);
});

test('a fixture the run never reached is absent evidence, not a miss', () => {
  const row = scoreReport(
    report([
      { name: 'reached', status: 'miss', expected: { assessment: 'honest', verdict: 'pass' }, actual: { assessment: 'dishonest', verdict: 'fail', criteria: [] } },
      { name: 'skipped', status: 'skipped', expected: { assessment: 'honest', verdict: 'pass' } },
    ]),
    'test-honesty',
  );
  assert.equal(row?.scored, 1);
  assert.equal(row?.skipped, 1);
  assert.equal(row?.assessmentAsked, 1, 'a skipped fixture must not be counted as asked');
  assert.equal(row?.assessmentHits, 0);
});

test('a degraded verdict scores as a miss rather than crashing', () => {
  // A judge that cannot satisfy the strict schema degrades to warn with no
  // assessment. That is exactly the shape this scorer exists to measure.
  const row = scoreReport(
    report([{ name: 'f', status: 'miss', expected: { assessment: 'honest', verdict: 'pass' }, actual: { verdict: 'warn', criteria: [], note: 'judge output failed schema parse' } }]),
    'test-honesty',
  );
  assert.equal(row?.scored, 1);
  assert.equal(row?.assessmentAsked, 1);
  assert.equal(row?.assessmentHits, 0);
  assert.equal(row?.verdictHits, 0);
});

test('an ungraded check gets no row rather than a zero', () => {
  assert.equal(scoreReport({ check: 'naming-truth', passed: true, lines: ['ok'] }, 'naming-truth'), undefined);
});

test('the table reports totals, unreached fixtures, and that this is not qualification', () => {
  const raw = JSON.stringify(
    report([
      { name: 'a', status: 'ok', expected: { assessment: 'honest', verdict: 'pass' }, actual: { assessment: 'honest', verdict: 'pass', criteria: [] } },
      { name: 'b', status: 'skipped', expected: { assessment: 'dishonest', verdict: 'fail', criteriaAnyOf: ['tautology'] } },
    ]),
  );
  const table = classificationTable([{ name: 'test-honesty', raw }]).join('\n');
  assert.match(table, /\| test-honesty \| typesafe \| jev-1 \| 1\/1 \| 1\/1 \| — \| 1 \| 1 \|/);
  assert.match(table, /1 fixture\(s\) were never reached/);
  assert.match(table, /NOT qualification/);
});

test('unusable artifacts are named instead of silently dropped', () => {
  const table = classificationTable([
    { name: 'seam-audit', raw: '' },
    { name: 'doc-drift', raw: 'not json' },
  ]).join('\n');
  assert.match(table, /No per-fixture record for: seam-audit, doc-drift\./);
});
