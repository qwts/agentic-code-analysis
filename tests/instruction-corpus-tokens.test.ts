import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ESTIMATOR_ID,
  defaultEstimator,
} from '../src/corpora/instructions/index.ts';
import { makeEstimate, sumEstimates } from '../src/corpora/instructions/token-estimate.ts';
import { fakeEstimator } from './instruction-corpus-helpers.ts';

// The reference calibration corpus from the conventions doc: pinned counts
// for the exact-pinned js-tiktoken o200k_base encoding. These change only
// when the pin moves — update intentionally, never via live calls.
const CALIBRATION: readonly { readonly name: string; readonly text: string; readonly tokens: number }[] = [
  {
    name: 'concise prose',
    text: 'A file should have the smallest practical context footprint that still completely represents one coherent concept.',
    tokens: 17,
  },
  {
    name: 'markdown lists and tables',
    text: '- build: npm test\n- lint: npm run typecheck\n\n| tier | model |\n| --- | --- |\n| T1 | fast |\n',
    tokens: 30,
  },
  {
    name: 'fenced code',
    text: '```ts\nexport function sum(a: number, b: number): number {\n  return a + b;\n}\n```\n',
    tokens: 25,
  },
  {
    name: 'frontmatter and paths',
    text: '---\nname: deploy\ndescription: Ship the service safely.\npaths:\n  - "src/api/**/*.ts"\n---\n',
    tokens: 23,
  },
  {
    name: 'non-ASCII text',
    text: 'Instrucciones para el agente: siempre verificar la cobertura de pruebas. 指示に従ってください。',
    tokens: 22,
  },
];

test('the pinned reference estimator reproduces the calibration corpus exactly', () => {
  assert.equal(DEFAULT_ESTIMATOR_ID, 'js-tiktoken@1.0.21/o200k_base');
  assert.equal(defaultEstimator.id, DEFAULT_ESTIMATOR_ID);
  for (const sample of CALIBRATION) {
    assert.equal(defaultEstimator.estimate(sample.text), sample.tokens, sample.name);
  }
  assert.equal(defaultEstimator.estimate(''), 0);
});

test('estimates always carry estimated: true and the estimator identity', () => {
  const estimate = makeEstimate(defaultEstimator, 'hello world');
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.estimator, DEFAULT_ESTIMATOR_ID);
  assert.ok(estimate.count > 0);
});

test('summation is plain arithmetic over charged segments and refuses to mix estimators', () => {
  const a = makeEstimate(fakeEstimator, 'one two three');
  const b = makeEstimate(fakeEstimator, 'four five');
  const total = sumEstimates(fakeEstimator.id, [a, b]);
  assert.equal(total.count, 5);
  assert.equal(total.estimated, true);
  assert.equal(sumEstimates(fakeEstimator.id, []).count, 0);

  const other = makeEstimate(defaultEstimator, 'six');
  assert.throws(() => sumEstimates(fakeEstimator.id, [a, other]), /cannot sum estimates/);
});
