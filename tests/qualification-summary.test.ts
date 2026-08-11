import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../scripts/qualification-summary.ts';

const graded = JSON.stringify({
  check: 'context-footprint',
  provider: 'openai',
  model: 'some-model',
  promptVersion: 'context-footprint-v3',
  requiredLevel: 'coverage',
  achievedLevel: 'coverage',
  qualified: true,
});

// naming-truth's self-test has no graded manifest, so the CLI emits the shared
// {passed, lines} shape. Reading a missing `qualified` field as failure would
// report a route that passed as unqualified (Codex, PR #74).
const ungraded = JSON.stringify({
  check: 'naming-truth',
  provider: 'openai',
  model: 'some-model',
  passed: true,
  lines: ['ok'],
});

test('a passing ungraded check is not reported as unqualified', () => {
  const table = summarize([{ name: 'naming-truth', raw: ungraded }], ['naming-truth']).join('\n');
  assert.match(table, /\| naming-truth \|.*\| ungraded \| ungraded \| yes \|/);
  assert.match(table, /1\/1 qualified\./);
});

test('a failing ungraded check still reads as not qualified', () => {
  const failed = JSON.stringify({ check: 'naming-truth', passed: false, lines: [] });
  const table = summarize([{ name: 'naming-truth', raw: failed }], ['naming-truth']).join('\n');
  assert.match(table, /\| naming-truth \|.*\| no \|/);
  assert.match(table, /0\/1 qualified\./);
});

test('a selected check with no artifact gets a row, not silence', () => {
  const table = summarize([{ name: 'context-footprint', raw: graded }], ['context-footprint', 'seam-audit']);
  const text = table.join('\n');
  assert.match(text, /\| seam-audit \|.*\| no result \|/);
  assert.match(text, /1\/2 qualified\./);
  assert.match(text, /no usable result: seam-audit\./);
  assert.match(text, /not a passing route\./);
});

test('empty and malformed payloads are visible rather than dropped', () => {
  const text = summarize(
    [
      { name: 'seam-audit', raw: '   ' },
      { name: 'doc-drift', raw: '{not json' },
    ],
    ['seam-audit', 'doc-drift'],
  ).join('\n');
  assert.match(text, /\| doc-drift \|.*\| unparsable \|/);
  assert.match(text, /\| seam-audit \|.*\| no output \|/);
  assert.match(text, /0\/2 qualified\./);
});

test('a graded check reports its achieved and required levels', () => {
  const text = summarize([{ name: 'context-footprint', raw: graded }], []).join('\n');
  assert.match(text, /\| context-footprint \| openai \| some-model \| context-footprint-v3 \| coverage \| coverage \| yes \|/);
});
