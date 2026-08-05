import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ambientCandidates, dependenciesOf } from '../src/checks/seam-audit/evidence.ts';

test('every dependency form is extracted: static, re-export, side-effect, dynamic, require', () => {
  const content = `import { a } from './a.ts';
export { b } from './b.ts';
import './side-effect.ts';
const dyn = await import('./dyn.ts');
const cjs = require('./cjs.ts');
import bare from 'external-pkg';
`;
  assert.deepEqual(dependenciesOf('src/x.ts', content), [
    'external-pkg',
    'src/a.ts',
    'src/b.ts',
    'src/cjs.ts',
    'src/dyn.ts',
    'src/side-effect.ts',
  ]);
});

test('dependencies are normalized against the importing file, deduplicated, and sorted', () => {
  const content = `import { a } from '../a.ts';
import { alias } from '../a.ts';
import { z } from './z.ts';
`;
  assert.deepEqual(dependenciesOf('src/nested/x.ts', content), ['src/a.ts', 'src/nested/z.ts']);
});

test('a dependency-free file yields no dependencies', () => {
  assert.deepEqual(dependenciesOf('x.ts', 'export const a = 1;\n'), []);
});

test('ambient candidates flag clock, randomness, network, env, globals, timers, and constructor calls', () => {
  const content = `const started = Date.now();
const jitter = Math.random();
await fetch(url);
const key = process.env.KEY;
globalThis.thing = 1;
document.title = 'x';
setTimeout(tick, 5);
const client = new Client(key);
`;
  assert.deepEqual(ambientCandidates(content), [
    'Date (clock)',
    'Math.random',
    'fetch',
    'process.*',
    'globalThis.*',
    'DOM/browser global',
    'timers',
    'constructor call (new X(...))',
  ]);
});

test('candidates are hints with fixed labels, not per-occurrence findings', () => {
  assert.deepEqual(ambientCandidates('Date.now(); Date.now(); Date.now();'), ['Date (clock)']);
  assert.deepEqual(ambientCandidates('const pure = [1, 2, 3].map((n) => n * 2);'), []);
});
