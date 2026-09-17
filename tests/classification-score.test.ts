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

// The real manifests use three expectation dialects, not one. Scoring only
// top-level string arrays silently reported review-readiness,
// commit-coherence and seam-audit as "labels not asked" (Cursor Bugbot, #90).

test('pair-fixture criteria objects are scored, anchored to their file and line', () => {
  const expected = {
    verdict: 'fail',
    criteria: [
      { criterion: 'leftover-debug', file: 'src/report.ts', line: 8 },
      { criterion: 'silenced-test', file: 'tests/report.test.ts', line: 9 },
    ],
  };
  const hit = scoreReport(
    report([
      {
        name: 'debris-multi-file',
        expected,
        actual: {
          verdict: 'fail',
          findings: [
            { criterion: 'leftover-debug', file: 'src/report.ts', line: 8 },
            { criterion: 'silenced-test', file: 'tests/report.test.ts', line: 9 },
          ],
        },
      },
    ]),
    'review-readiness',
  );
  assert.equal(hit?.labelAsked, 1, 'object criteria must be read as a constraint, not skipped');
  assert.equal(hit?.labelHits, 1);

  // Pair criteria are all-of: one of two detected is a miss.
  const partial = scoreReport(
    report([{ name: 'debris-multi-file', expected, actual: { verdict: 'fail', findings: [{ criterion: 'leftover-debug', file: 'src/report.ts', line: 8 }] } }]),
    'review-readiness',
  );
  assert.equal(partial?.labelHits, 0);

  // Right criterion, wrong file is not a detection.
  const wrongFile = scoreReport(
    report([
      {
        name: 'debris-multi-file',
        expected,
        actual: {
          verdict: 'fail',
          findings: [
            { criterion: 'leftover-debug', file: 'src/other.ts', line: 8 },
            { criterion: 'silenced-test', file: 'tests/report.test.ts', line: 9 },
          ],
        },
      },
    ]),
    'review-readiness',
  );
  assert.equal(wrongFile?.labelHits, 0);
});

test('commit-coherence findings anchor through their files array', () => {
  const row = scoreReport(
    report([
      {
        name: 'mixed-rename-and-retry',
        expected: { verdict: 'fail', criteria: [{ criterion: 'mixed-refactor-and-behavior', file: 'src/http.ts' }] },
        actual: { verdict: 'fail', findings: [{ criterion: 'mixed-refactor-and-behavior', files: ['src/user.ts', 'src/http.ts'] }] },
      },
    ]),
    'commit-coherence',
  );
  assert.equal(row?.labelHits, 1);
});

test('seam-audit footprint entries match the formatted "dependency (criterion)" strings', () => {
  const expected = {
    assessment: 'new-violating',
    verdict: 'fail',
    blockingAllOf: [
      { dependency: 'Date.now', criterion: 'ambient-state' },
      { dependency: 'fetch', criterion: 'ambient-io' },
    ],
  };
  const hit = scoreReport(
    report([{ name: 'new-hardwired', expected, actual: { assessment: 'new-violating', verdict: 'fail', blocking: ['Date.now (ambient-state)', 'globalThis.fetch (ambient-io)'], residual: [] } }]),
    'seam-audit',
  );
  assert.equal(hit?.labelAsked, 1);
  assert.equal(hit?.labelHits, 1, 'dependency matches by case-insensitive substring');

  // A residual expectation is not satisfied by a blocking item: the buckets
  // are never pooled.
  const wrongBucket = scoreReport(
    report([
      {
        name: 'legacy-held-residual',
        expected: { assessment: 'held', verdict: 'pass', residualAllOf: [{ dependency: 'Date.now' }] },
        actual: { assessment: 'held', verdict: 'pass', blocking: ['Date.now (ambient-state)'], residual: [] },
      },
    ]),
    'seam-audit',
  );
  assert.equal(wrongBucket?.labelAsked, 1);
  assert.equal(wrongBucket?.labelHits, 0);

  // Criterion mismatch on a matching dependency is still a miss.
  const wrongCriterion = scoreReport(
    report([{ name: 'new-hardwired', expected, actual: { assessment: 'new-violating', verdict: 'fail', blocking: ['Date.now (ambient-io)', 'fetch (ambient-io)'], residual: [] } }]),
    'seam-audit',
  );
  assert.equal(wrongCriterion?.labelHits, 0);
});

test('seam-audit emptyFootprint is scored as a classification claim', () => {
  const expected = { assessment: 'new-compliant', verdict: 'pass', emptyFootprint: true };
  const clean = scoreReport(report([{ name: 'new-injected', expected, actual: { assessment: 'new-compliant', verdict: 'pass', blocking: [], residual: [] } }]), 'seam-audit');
  assert.equal(clean?.labelAsked, 1);
  assert.equal(clean?.labelHits, 1);

  const dirty = scoreReport(
    report([{ name: 'new-injected', expected, actual: { assessment: 'new-compliant', verdict: 'pass', blocking: ['Date.now (ambient-state)'], residual: [] } }]),
    'seam-audit',
  );
  assert.equal(dirty?.labelHits, 0);
});

test('an unreadable expectation key is reported, never read as unasked', () => {
  // agent-rule-conflict carries sharedSessions as string[][]. Scoring it is
  // out of scope, but silently dropping it is how the object dialects went
  // unnoticed in the first place.
  const row = scoreReport(
    report([{ name: 'f', expected: { criteriaAnyOf: ['contradiction'], sharedSessions: [['a', 'b']] }, actual: { verdict: 'fail', criteria: ['contradiction'] } }]),
    'agent-rule-conflict',
  );
  assert.equal(row?.labelAsked, 1);
  assert.equal(row?.labelHits, 1);
  assert.deepEqual(row?.unreadable, ['sharedSessions']);

  const table = classificationTable([
    {
      name: 'agent-rule-conflict',
      raw: JSON.stringify(report([{ name: 'f', expected: { sharedSessions: [['a', 'b']] }, actual: { verdict: 'fail', criteria: [] } }], { check: 'agent-rule-conflict' })),
    },
  ]).join('\n');
  assert.match(table, /cannot read[\s\S]*agent-rule-conflict: sharedSessions/);
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
