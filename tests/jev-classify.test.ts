import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criteriaFrom, gradeFixture, noulKey, NOUL_THRESHOLD } from '../scripts/jev-classify.ts';
import { settledAt } from '../scripts/jev-corpus.ts';
import { CRITERIA } from '../src/checks/test-honesty/judge-io.ts';

// Nouls keyed the way the script asks them, so a test that passes here is
// exercising the shape the API actually answers with — the defect #90's
// review history records is a test written against an assumed shape.
function nouls(filed: Partial<Record<(typeof CRITERIA)[number], number>>): Record<string, number> {
  return Object.fromEntries(CRITERIA.map((c) => [noulKey(c), filed[c] ?? 0]));
}

test('a criterion is filed only at or above the threshold', () => {
  assert.deepEqual(criteriaFrom(nouls({ tautology: NOUL_THRESHOLD })), ['tautology']);
  assert.deepEqual(criteriaFrom(nouls({ tautology: NOUL_THRESHOLD - 0.01 })), []);
});

test('criteria come back in the check\'s declared order, not answer order', () => {
  const filed = criteriaFrom(nouls({ 'unreviewable-snapshot': 0.9, 'asserts-own-mock': 0.9 }));
  // asserts-own-mock precedes unreviewable-snapshot in CRITERIA.
  assert.deepEqual(filed, ['asserts-own-mock', 'unreviewable-snapshot']);
});

test('a missing Noul reads as not filed rather than throwing', () => {
  assert.deepEqual(criteriaFrom({}), []);
});

test('an explicit threshold overrides the default', () => {
  assert.deepEqual(criteriaFrom(nouls({ tautology: 0.6 }), 0.7), []);
  assert.deepEqual(criteriaFrom(nouls({ tautology: 0.6 }), 0.5), ['tautology']);
});

test('noulKey survives hyphenated criteria', () => {
  assert.equal(noulKey('no-meaningful-assertion'), 'criterion_no_meaningful_assertion');
});

test('a fixture matches only when every asked axis matches', () => {
  const expect = { assessment: 'dishonest', verdict: 'fail', criteriaAnyOf: ['tautology'] };
  const actual = { assessment: 'dishonest', verdict: 'fail', criteria: ['tautology'] };
  assert.equal(gradeFixture(expect, actual), 'ok');
  assert.equal(gradeFixture(expect, { ...actual, assessment: 'honest' }), 'miss');
  assert.equal(gradeFixture(expect, { ...actual, verdict: 'warn' }), 'miss');
  assert.equal(gradeFixture(expect, { ...actual, criteria: ['asserts-own-mock'] }), 'miss');
});

test('anyOf needs one of the listed labels, not all of them', () => {
  const expect = { assessment: 'dishonest', verdict: 'fail', criteriaAnyOf: ['tautology', 'asserts-own-mock'] };
  assert.equal(gradeFixture(expect, { assessment: 'dishonest', verdict: 'fail', criteria: ['asserts-own-mock'] }), 'ok');
});

test('an absent label constraint is not asked, and extra labels do not fail it', () => {
  // A pass fixture carries no criteriaAnyOf: filing nothing is correct, and
  // filing something extra is not graded here — the label axis was not asked.
  const expect = { assessment: 'honest', verdict: 'pass' };
  assert.equal(gradeFixture(expect, { assessment: 'honest', verdict: 'pass', criteria: [] }), 'ok');
  assert.equal(gradeFixture(expect, { assessment: 'honest', verdict: 'pass', criteria: ['tautology'] }), 'ok');
});

test('a screen settles confident passes and escalates everything else', () => {
  const rows = [
    { file: 'a', verdict: 'pass', confidence: 0.9 },
    { file: 'b', verdict: 'pass', confidence: 0.5 },
    { file: 'c', verdict: 'fail', confidence: 0.99 },
    { file: 'd', verdict: 'warn', confidence: 0.99 },
  ];
  assert.deepEqual(
    settledAt(rows, 0.7).map((r) => r.file),
    ['a'],
  );
  // A certain fail still escalates: the judge owns the prose (ACA-0080).
  assert.equal(
    settledAt(rows, 0.7).some((r) => r.verdict !== 'pass'),
    false,
  );
});

test('the settle threshold is inclusive at its boundary', () => {
  const rows = [{ file: 'a', verdict: 'pass', confidence: 0.7 }];
  assert.equal(settledAt(rows, 0.7).length, 1);
  assert.equal(settledAt(rows, 0.71).length, 0);
});
