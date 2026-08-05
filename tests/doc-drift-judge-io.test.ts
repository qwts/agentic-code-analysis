import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceBundle } from '../src/checks/doc-drift/evidence.ts';
import { judgeOutcome, systemPrompt, userPrompt, rubricText, type DriftFinding } from '../src/checks/doc-drift/judge-io.ts';

const BUNDLE: EvidenceBundle = {
  references: [
    { id: 'r1', kind: 'path', literal: '../src/a.ts', line: 3, referentPath: 'src/a.ts', status: 'modified' },
    { id: 'r2', kind: 'symbol', literal: 'gone', line: 5, referentPath: 'src/b.ts', status: 'deleted' },
  ],
  referents: [
    { path: 'src/a.ts', status: 'modified', content: 'export const a = 1;\n' },
    { path: 'src/b.ts', status: 'deleted' },
  ],
  unreadable: [],
};

const finding = (over: Partial<DriftFinding> = {}): DriftFinding => ({
  criterion: 'claim-contradicts-code',
  claim: 'the doc says a is 2',
  reference_ids: ['r1'],
  evidence: 'src/a.ts sets a = 1',
  suggestion: 'update the doc',
  ...over,
});

const reply = (assessment: string, findings: DriftFinding[] = []) => ({
  ok: true as const,
  verdict: { assessment, findings, reasoning_summary: 'summary' },
});

test('aligned with no findings is a cacheable pass carrying the audit fields', () => {
  const { verdict, cacheable } = judgeOutcome('docs/x.md', BUNDLE, reply('aligned'));
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.assessment, 'aligned');
  assert.equal(cacheable, true);
  assert.equal(verdict.scanMode, 'explicit-markdown-references');
  assert.deepEqual(verdict.references.map((r) => r.id), ['r1', 'r2']);
  assert.ok(verdict.referents.every((r) => !('content' in r)), 'audit referents must not carry contents');
});

test('drifted with a blocking finding fails on that evidence and caches', () => {
  const { verdict, cacheable } = judgeOutcome('docs/x.md', BUNDLE, reply('drifted', [finding()]));
  assert.equal(verdict.verdict, 'fail');
  assert.equal(cacheable, true);
  assert.equal(verdict.violations[0]!.criterion, 'claim-contradicts-code');
  assert.match(verdict.violations[0]!.evidence, /the doc says a is 2/);
  assert.deepEqual(verdict.findings![0]!.reference_ids, ['r1']);
});

test('incomplete with only incomplete-new-behavior is a cacheable warn; uncertain is a cacheable warn', () => {
  const incomplete = judgeOutcome('docs/x.md', BUNDLE, reply('incomplete', [finding({ criterion: 'incomplete-new-behavior' })]));
  assert.equal(incomplete.verdict.verdict, 'warn');
  assert.equal(incomplete.cacheable, true);
  const uncertain = judgeOutcome('docs/x.md', BUNDLE, reply('uncertain'));
  assert.equal(uncertain.verdict.verdict, 'warn');
  assert.equal(uncertain.cacheable, true);
});

test('malformed replies degrade to non-cacheable warns', () => {
  const cases = [
    { name: 'transport failure', result: { ok: false as const, note: 'overloaded' } },
    { name: 'schema shape', result: { ok: true as const, verdict: { assessment: 'drifted' } } },
    { name: 'unknown assessment', result: reply('meh') },
    { name: 'unknown reference id', result: reply('drifted', [finding({ reference_ids: ['r99'] })]) },
    { name: 'blank evidence', result: reply('drifted', [finding({ evidence: '  ' })]) },
    { name: 'drifted without blocking criterion', result: reply('drifted', [finding({ criterion: 'incomplete-new-behavior' })]) },
    { name: 'incomplete with blocking finding', result: reply('incomplete', [finding()]) },
    { name: 'incomplete without findings', result: reply('incomplete') },
    { name: 'aligned with findings', result: reply('aligned', [finding()]) },
    { name: 'uncertain with findings', result: reply('uncertain', [finding()]) },
    { name: 'empty reference_ids', result: reply('drifted', [finding({ reference_ids: [] })]) },
  ];
  for (const { name, result } of cases) {
    const { verdict, cacheable } = judgeOutcome('docs/x.md', BUNDLE, result);
    assert.equal(verdict.verdict, 'warn', name);
    assert.equal(cacheable, false, name);
    assert.equal(verdict.assessment, undefined, name);
  }
});

test('the system prompt embeds the rubric verbatim; the user prompt carries records, doc, and evidence markers', () => {
  const rubric = rubricText();
  assert.ok(systemPrompt(rubric).includes(rubric));
  const user = userPrompt('docs/x.md', '# Doc body', BUNDLE);
  assert.match(user, /r1: \[path\] "\.\.\/src\/a\.ts" \(doc line 3\) -> src\/a\.ts \(modified\)/);
  assert.match(user, /# Doc body/);
  assert.match(user, /src\/b\.ts \(DELETED at head/);
  assert.match(user, /export const a = 1;/);
});
