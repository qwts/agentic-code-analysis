import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TEST_GLOBS } from '../src/checks/test-honesty/scope.ts';
import { buildEvidence, externalSnapshotUnresolved, MAX_COMPANION_BYTES, MAX_UNITS } from '../src/checks/test-honesty/unit-context.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-evidence-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const TEST_CONTENT = `import { add } from '../src/adder.ts';\ntest('add sums', () => {});\n`;

test('a direct static local import resolves to the unit path and its export surface', () => {
  const root = repo({ 'src/adder.ts': `const carry = 0;\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n` });
  const evidence = buildEvidence(root, 'tests/adder.test.ts', TEST_CONTENT, DEFAULT_TEST_GLOBS);
  assert.equal(evidence.mode, 'unit-exports');
  assert.deepEqual(evidence.units, [{ path: 'src/adder.ts', exports: ['export function add(a: number, b: number): number {'] }]);
  assert.deepEqual(evidence.unavailable, []);
});

test('extensionless specifiers resolve deterministically', () => {
  const root = repo({ 'src/adder.ts': 'export const add = 1;\n' });
  const evidence = buildEvidence(root, 'tests/adder.test.ts', `import { add } from '../src/adder';\n`, DEFAULT_TEST_GLOBS);
  assert.equal(evidence.units[0]?.path, 'src/adder.ts');
});

test('other test files, helpers, mocks, and fixtures are never the unit under test', () => {
  const root = repo({
    'tests/other.test.ts': 'export const x = 1;\n',
    'tests/helpers.ts': 'export const h = 1;\n',
    'tests/__mocks__/gateway.ts': 'export const g = 1;\n',
    'tests/fixtures/data.ts': 'export const d = 1;\n',
  });
  const content = `import { x } from './other.test.ts';\nimport { h } from './helpers.ts';\nimport { g } from './__mocks__/gateway.ts';\nimport { d } from './fixtures/data.ts';\n`;
  const evidence = buildEvidence(root, 'tests/a.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.equal(evidence.mode, 'test-only');
  assert.deepEqual(evidence.units, []);
  assert.deepEqual(evidence.unavailable, ['unit exports unavailable']);
});

test('unresolvable and repo-escaping specifiers become explicit markers, never findings', () => {
  const root = repo({});
  const content = `import { a } from './missing.ts';\nimport { b } from '../../outside.ts';\n`;
  const evidence = buildEvidence(root, 'tests/a.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.deepEqual(evidence.unavailable, [
    'unit exports unavailable: ./missing.ts',
    'unit exports unavailable: ../../outside.ts',
    'unit exports unavailable',
  ]);
});

test('a non-code test file degrades to test-file-only judgment with the marker', () => {
  const evidence = buildEvidence(repo({}), 'tests/test_scope.py', 'from app import scope\n', DEFAULT_TEST_GLOBS);
  assert.equal(evidence.mode, 'test-only');
  assert.deepEqual(evidence.unavailable, ['unit exports unavailable']);
});

test('at most MAX_UNITS units, in source order', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' });
  const content = `import { a } from '../src/a.ts';\nimport { b } from '../src/b.ts';\nimport { c } from '../src/c.ts';\n`;
  const evidence = buildEvidence(root, 'tests/a.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.equal(evidence.units.length, MAX_UNITS);
  assert.deepEqual(evidence.units.map((u) => u.path), ['src/a.ts', 'src/b.ts']);
});

test('an over-bound export surface is replaced by its marker', () => {
  const root = repo({ 'src/big.ts': `export const blob = '${'x'.repeat(MAX_COMPANION_BYTES + 1)}';\n` });
  const evidence = buildEvidence(root, 'tests/a.test.ts', `import { blob } from '../src/big.ts';\n`, DEFAULT_TEST_GLOBS);
  assert.deepEqual(evidence.units, []);
  assert.ok(evidence.unavailable.includes('unit exports unavailable: src/big.ts'));
});

test('an external snapshot reference resolves the conventional snapshot file', () => {
  const root = repo({ 'tests/__snapshots__/comp.test.ts.snap': 'exports[`renders`] = `<div/>`;\n' });
  const content = `test('renders', () => { expect(render()).toMatchSnapshot(); });\n`;
  const evidence = buildEvidence(root, 'tests/comp.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.deepEqual(evidence.snapshots.map((s) => s.path), ['tests/__snapshots__/comp.test.ts.snap']);
  assert.ok(!externalSnapshotUnresolved(evidence));
});

test('an unresolved external snapshot becomes a marker the host guard can see', () => {
  const content = `test('renders', () => { expect(render()).toMatchSnapshot(); });\n`;
  const evidence = buildEvidence(repo({}), 'tests/comp.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.deepEqual(evidence.snapshots, []);
  assert.ok(externalSnapshotUnresolved(evidence));
});

test('inline snapshots are visible in the file and raise no external marker', () => {
  const content = `test('renders', () => { expect(render()).toMatchInlineSnapshot(\`"<div/>"\`); });\n`;
  const evidence = buildEvidence(repo({}), 'tests/comp.test.ts', content, DEFAULT_TEST_GLOBS);
  assert.ok(!externalSnapshotUnresolved(evidence));
});
