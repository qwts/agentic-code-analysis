import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/core/config.ts';
import { addedLineIndex } from '../src/core/diff-artifact.ts';
import { matchPairExpectation, validatePairManifest } from '../src/checks/pair-fixtures.ts';
import { loadFixtureSuite } from '../src/checks/review-readiness/self-test.ts';

// ACA-0020 requirement 4: the shipped pair corpus round-trips — load → diff
// → assert — without any judge call.
test('shipped pair fixtures round-trip: trees load, diffs are non-empty, every expected anchor is an added head line', () => {
  const { manifest, cases } = loadFixtureSuite();
  assert.equal(manifest.schemaVersion, 1);
  for (const fixture of manifest.fixtures) {
    const loaded = cases.get(fixture.name)!;
    assert.ok(loaded.artifact.files.length > 0, `${fixture.name}: the pair must actually differ`);
    assert.ok(loaded.artifact.files.length >= 2 || fixture.expect.criteria.length === 0, `${fixture.name}: smell cases span multiple files`);
    const anchors = addedLineIndex(loaded.artifact);
    for (const expected of fixture.expect.criteria) {
      assert.ok(
        expected.line !== undefined && anchors.get(expected.file)?.has(expected.line),
        `${fixture.name}: expected anchor ${expected.file}:${expected.line} must be an added head line`,
      );
    }
  }
});

test('the expectation oracle is all-of: one undetected criterion is a miss', () => {
  const expect = {
    verdict: 'fail' as const,
    criteria: [
      { criterion: 'leftover-debug', file: 'src/report.ts', line: 8 },
      { criterion: 'silenced-test', file: 'tests/report.test.ts', line: 9 },
    ],
  };
  const debug = { criterion: 'leftover-debug', file: 'src/report.ts', line: 8 };
  const silenced = { criterion: 'silenced-test', file: 'tests/report.test.ts', line: 9 };
  assert.equal(matchPairExpectation(expect, { verdict: 'fail', findings: [debug, silenced] }), true);
  assert.equal(matchPairExpectation(expect, { verdict: 'fail', findings: [silenced, debug] }), true, 'order-independent');
  assert.equal(matchPairExpectation(expect, { verdict: 'fail', findings: [debug] }), false, 'missing criterion is a miss');
  assert.equal(matchPairExpectation(expect, { verdict: 'fail', findings: [debug, { ...silenced, line: 10 }] }), false, 'wrong anchor line is a miss');
  assert.equal(matchPairExpectation(expect, { verdict: 'warn', findings: [debug, silenced] }), false, 'wrong verdict is a miss');
  assert.equal(matchPairExpectation({ verdict: 'pass', criteria: [] }, { verdict: 'pass', findings: [] }), true);
});

test('manifest validation rejects malformed packages before any judge call', () => {
  const valid = {
    schemaVersion: 1,
    requiredLevel: 'basic',
    levels: [{ id: 'basic' }],
    fixtures: [{ name: 'case', level: 'basic', dir: 'case-dir', expect: { verdict: 'pass', criteria: [] } }],
  };
  const criteria = ['leftover-debug'];
  assert.equal(validatePairManifest(structuredClone(valid), criteria).requiredLevel, 'basic');

  const reject = (mutate: (m: typeof valid) => unknown, pattern: RegExp): void => {
    const clone = structuredClone(valid);
    const raw = mutate(clone) ?? clone;
    assert.throws(() => validatePairManifest(raw, criteria), (err: unknown) => err instanceof ConfigError && pattern.test((err as Error).message));
  };
  reject((m) => ({ ...m, schemaVersion: 2 }), /schemaVersion/);
  reject((m) => ({ ...m, requiredLevel: 'ghost' }), /not a declared level/);
  reject((m) => {
    m.fixtures.push(structuredClone(m.fixtures[0]!));
    return m;
  }, /duplicate fixture/);
  reject((m) => {
    m.fixtures[0]!.dir = '../escape';
    return m;
  }, /bare directory name/);
  reject((m) => {
    m.fixtures[0]!.expect.criteria = [{ criterion: 'not-a-criterion', file: 'x.ts' }] as never;
    return m;
  }, /unknown criterion/);
  reject((m) => {
    m.levels.push({ id: 'empty' });
    return m;
  }, /has no fixtures/);
});
