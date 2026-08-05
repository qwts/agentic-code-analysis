import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffArtifactFromTrees, type DiffArtifact } from '../src/core/diff-artifact.ts';
import { judgeOutcome, unitIndex, validateSplit, VERDICT_SCHEMA } from '../src/checks/commit-coherence/judge-io.ts';

// a.ts and b.ts modified (one hunk each), c.ts added (one hunk).
const artifact = diffArtifactFromTrees(
  new Map([
    ['a.ts', 'one\n'],
    ['b.ts', 'x\n'],
  ]),
  new Map([
    ['a.ts', 'two\n'],
    ['b.ts', 'y\n'],
    ['c.ts', 'new\n'],
  ]),
);

const reply = (overrides: Record<string, unknown>) => ({
  ok: true as const,
  verdict: {
    assessment: 'coherent',
    overall_intent: 'one change',
    findings: [],
    split_proposal: [],
    reasoning_summary: 'looks like one intent',
    ...overrides,
  },
});

const finding = { criterion: 'mixed-refactor-and-behavior', files: ['a.ts', 'b.ts'], evidence: 'rename entangled with behavior' };
const goodSplit = [
  { name: 'rename', intent: 'mechanical rename', units: ['a.ts'] },
  { name: 'behavior', intent: 'retry change', units: ['b.ts', 'c.ts'] },
];

test('judged outcomes map and cache: coherent -> pass, uncertain -> warn, entangled -> fail', () => {
  const pass = judgeOutcome(reply({}), artifact);
  assert.deepEqual([pass.verdict, pass.assessment, pass.cacheable, pass.overallIntent], ['pass', 'coherent', true, 'one change']);

  const warn = judgeOutcome(reply({ assessment: 'uncertain' }), artifact);
  assert.deepEqual([warn.verdict, warn.assessment, warn.cacheable, warn.note], ['warn', 'uncertain', true, 'looks like one intent']);

  const fail = judgeOutcome(reply({ assessment: 'entangled', findings: [finding], split_proposal: goodSplit }), artifact);
  assert.deepEqual([fail.verdict, fail.assessment, fail.cacheable], ['fail', 'entangled', true]);
  assert.deepEqual(fail.findings, [finding]);
  assert.deepEqual(fail.splitProposal, goodSplit);
});

test('transport failures and malformed replies degrade to a non-cacheable warn', () => {
  const transport = judgeOutcome({ ok: false, note: 'api error: overloaded' }, artifact);
  assert.deepEqual([transport.verdict, transport.cacheable, transport.note], ['warn', false, 'api error: overloaded']);
  const malformed = judgeOutcome({ ok: true, verdict: 42 }, artifact);
  assert.deepEqual([malformed.verdict, malformed.cacheable], ['warn', false]);
  const blankIntent = judgeOutcome(reply({ overall_intent: '   ' }), artifact);
  assert.deepEqual([blankIntent.verdict, blankIntent.cacheable], ['warn', false]);
});

test('contradictions degrade: findings or split parts under a non-entangled assessment', () => {
  for (const assessment of ['coherent', 'uncertain']) {
    const withFinding = judgeOutcome(reply({ assessment, findings: [finding] }), artifact);
    assert.deepEqual([withFinding.verdict, withFinding.cacheable], ['warn', false], `${assessment} with findings`);
    const withSplit = judgeOutcome(reply({ assessment, split_proposal: goodSplit }), artifact);
    assert.deepEqual([withSplit.verdict, withSplit.cacheable], ['warn', false], `${assessment} with split`);
  }
});

test('entangled without a usable finding degrades: none named, unknown file, blank evidence', () => {
  const entangled = (overrides: Record<string, unknown>) => judgeOutcome(reply({ assessment: 'entangled', split_proposal: goodSplit, ...overrides }), artifact);
  assert.equal(entangled({ findings: [] }).cacheable, false);
  const unknown = entangled({ findings: [{ ...finding, files: ['a.ts', 'ghost.ts'] }] });
  assert.deepEqual([unknown.verdict, unknown.cacheable], ['warn', false]);
  assert.match(unknown.note!, /ghost\.ts/);
  assert.equal(entangled({ findings: [{ ...finding, evidence: ' ' }] }).cacheable, false);
});

test('an invalid split degrades the whole reply — never a repaired or partial fail', () => {
  const entangled = (split: unknown) => judgeOutcome(reply({ assessment: 'entangled', findings: [finding], split_proposal: split }), artifact);
  for (const [label, split] of Object.entries({
    'one part': [{ name: 'all', intent: 'everything', units: ['a.ts', 'b.ts', 'c.ts'] }],
    'invented anchor': [goodSplit[0]!, { ...goodSplit[1]!, units: ['b.ts', 'c.ts', 'd.ts'] }],
    overlap: [goodSplit[0]!, { ...goodSplit[1]!, units: ['a.ts@h1', 'b.ts', 'c.ts'] }],
    gap: [goodSplit[0]!, { ...goodSplit[1]!, units: ['b.ts'] }],
    'blank part name': [{ ...goodSplit[0]!, name: ' ' }, goodSplit[1]!],
    'bad hunk index': [goodSplit[0]!, { ...goodSplit[1]!, units: ['b.ts@h2', 'c.ts'] }],
  })) {
    const outcome = entangled(split);
    assert.deepEqual([outcome.verdict, outcome.cacheable], ['warn', false], label);
    assert.match(outcome.note!, /split/, label);
    assert.deepEqual([outcome.findings, outcome.splitProposal], [[], []], `${label}: nothing survives a degraded reply`);
  }
});

test('validateSplit accepts hunk-level partitions and whole-file claims of hunkless files', () => {
  assert.equal(
    validateSplit(artifact, [
      { name: 'a', intent: 'x', units: ['a.ts@h1'] },
      { name: 'rest', intent: 'y', units: ['b.ts@h1', 'c.ts@h1'] },
    ]),
    null,
  );
  const withBinary: DiffArtifact = { files: [...artifact.files, { path: 'logo.png', status: 'modified', binary: true, hunks: [] }] };
  assert.equal(
    validateSplit(withBinary, [
      { name: 'code', intent: 'x', units: ['a.ts', 'b.ts', 'c.ts'] },
      { name: 'asset', intent: 'y', units: ['logo.png'] },
    ]),
    null,
  );
  assert.match(validateSplit(withBinary, [{ name: 'code', intent: 'x', units: ['a.ts', 'b.ts', 'c.ts'] }, { name: 'asset', intent: 'y', units: ['logo.png@h1'] }])!, /logo\.png@h1/, 'a hunkless file has no hunk units');
});

test('the unit index lists every file with its hunk ids and head ranges', () => {
  const index = unitIndex({ files: [...artifact.files, { path: 'logo.png', status: 'modified', binary: true, hunks: [] }] });
  assert.match(index, /a\.ts: @h1 \(\+1,1\)/);
  assert.match(index, /logo\.png: \(whole file — no hunks\)/);
});

test('the schema is strict: every field required, no extras', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], ['assessment', 'overall_intent', 'findings', 'split_proposal', 'reasoning_summary']);
});
