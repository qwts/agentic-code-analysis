// Fixture-package integrity (ACA-0020 requirement 4) and the pure
// calibration oracles: load -> validate -> diff -> assert, no judge call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/core/config.ts';
import { MAX_PAYLOAD_CHARS, renderPayload } from '../src/core/diff-artifact.ts';
import { matchSplitExpectation, validateCoherenceExtras } from '../src/checks/commit-coherence/calibration.ts';
import { loadFixtureSuite } from '../src/checks/commit-coherence/self-test.ts';
import { validateSplit } from '../src/checks/commit-coherence/judge-io.ts';

test('the shipped fixture package round-trips: manifest, extras, trees, and payloads all validate', () => {
  const { manifest, extras, cases } = loadFixtureSuite();
  assert.equal(manifest.requiredLevel, 'discriminates');
  assert.deepEqual([...cases.keys()].sort(), ['coherent-larger-change', 'mixed-rename-and-retry']);
  for (const [name, loaded] of cases) {
    assert.ok(loaded.artifact.files.length > 0, `${name}: the pair produces a non-empty diff`);
    assert.equal(renderPayload(loaded.artifact, MAX_PAYLOAD_CHARS).omitted.length, 0, `${name}: fits the payload bound`);
  }
  // Every split anchor names a file the artifact actually changes.
  for (const [name, expectation] of extras.splits) {
    const paths = new Set(cases.get(name)!.artifact.files.map((file) => file.path));
    for (const group of expectation.groups) {
      for (const anchor of group.anchors) assert.ok(paths.has(anchor), `${name}: split anchor ${anchor} is a changed file`);
    }
  }
  // The expected finding anchor exists in the failing artifact.
  const fail = manifest.fixtures.find((fixture) => fixture.name === 'mixed-rename-and-retry')!;
  const failPaths = new Set(cases.get(fail.name)!.artifact.files.map((file) => file.path));
  for (const criterion of fail.expect.criteria) assert.ok(failPaths.has(criterion.file), `finding anchor ${criterion.file} exists`);
});

test('the size trap is mechanical: the passing fixture renders strictly larger than the failing one', () => {
  const { extras, cases } = loadFixtureSuite();
  const size = (name: string): number => renderPayload(cases.get(name)!.artifact, MAX_PAYLOAD_CHARS).text.length;
  assert.equal(extras.sizeInvariant.larger, 'coherent-larger-change');
  assert.equal(extras.sizeInvariant.smaller, 'mixed-rename-and-retry');
  assert.ok(
    size(extras.sizeInvariant.larger) > size(extras.sizeInvariant.smaller),
    `pass fixture (${size(extras.sizeInvariant.larger)} chars) must out-size the fail fixture (${size(extras.sizeInvariant.smaller)} chars)`,
  );
});

test('the ideal split of the failing fixture is itself a valid partition', () => {
  const { extras, cases } = loadFixtureSuite();
  const artifact = cases.get('mixed-rename-and-retry')!.artifact;
  const groups = extras.splits.get('mixed-rename-and-retry')!.groups;
  const parts = groups.map((group, index) => ({ name: `part ${index + 1}`, intent: 'expected grouping', units: group.anchors }));
  assert.equal(validateSplit(artifact, parts), null, 'the expectation must be satisfiable at file granularity');
});

test('the split oracle asserts grouping into distinct parts, not prose or order', () => {
  const groups = { groups: [{ anchors: ['x.ts', 'y.ts'] }, { anchors: ['z.ts'] }] };
  const part = (name: string, units: string[]) => ({ name, intent: 'i', units });
  assert.ok(matchSplitExpectation(groups, [part('b', ['z.ts']), part('a', ['x.ts', 'y.ts'])]), 'order-independent');
  assert.ok(matchSplitExpectation(groups, [part('a', ['x.ts@h1', 'x.ts@h2', 'y.ts']), part('b', ['z.ts', 'w.ts'])]), 'hunk units and extra files still touch their anchors');
  assert.ok(!matchSplitExpectation(groups, [part('all', ['x.ts', 'y.ts', 'z.ts']), part('rest', ['w.ts'])]), 'both groups in one part is not a separation');
  assert.ok(!matchSplitExpectation(groups, [part('a', ['x.ts']), part('b', ['z.ts'])]), 'a missing anchor is a miss');
});

test('malformed check-local manifest fields are configuration errors, never judge misses', () => {
  const { manifest } = loadFixtureSuite();
  const strip = (raw: Record<string, unknown>) => validateCoherenceExtras(raw, manifest);
  assert.throws(() => strip({}), ConfigError, 'sizeInvariant is required');
  assert.throws(() => strip({ sizeInvariant: { larger: 'mixed-rename-and-retry', smaller: 'mixed-rename-and-retry' } }), ConfigError, 'distinct fixtures required');
  assert.throws(() => strip({ sizeInvariant: { larger: 'nope', smaller: 'mixed-rename-and-retry' } }), ConfigError, 'declared fixtures only');

  // The split fields ride on the manifest's fixture objects; vary them and
  // pass the same object as raw and manifest, as production does.
  const failFixture = manifest.fixtures.find((fixture) => fixture.expect.verdict === 'fail')!;
  const passFixture = manifest.fixtures.find((fixture) => fixture.expect.verdict === 'pass')!;
  const variant = (fail: unknown, pass: unknown) => {
    const varied = {
      ...manifest,
      sizeInvariant: { larger: 'coherent-larger-change', smaller: 'mixed-rename-and-retry' },
      fixtures: [
        { ...failFixture, ...(fail === undefined ? { split: undefined } : { split: fail }) },
        { ...passFixture, ...(pass === undefined ? {} : { split: pass }) },
      ],
    };
    return validateCoherenceExtras(varied, varied as never);
  };
  assert.throws(() => variant(undefined, undefined), ConfigError, 'a fail fixture needs split groups');
  assert.throws(() => variant({ groups: [{ anchors: ['x'] }] }, undefined), ConfigError, 'fewer than two groups');
  assert.throws(() => variant({ groups: [{ anchors: [] }, { anchors: ['x'] }] }, undefined), ConfigError, 'groups need anchors');
  assert.throws(() => variant({ groups: [{ anchors: ['a'] }, { anchors: ['b'] }] }, { groups: [] }), ConfigError, 'split expectations belong on fail fixtures only');
});
