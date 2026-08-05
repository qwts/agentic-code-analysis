import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/core/config.ts';
import { DEFAULT_TEST_GLOBS, isTestFile, scopeTestFiles, testFileGlobs } from '../src/checks/test-honesty/scope.ts';

test('default globs match conventional test layouts and skip production files', () => {
  const tests = [
    'tests/cli.test.ts',
    'cli.test.ts',
    'src/__tests__/util.js',
    'app/widget.spec.tsx',
    'tests/test_scope.py',
    'pkg/scope_test.go',
    'tests/integration.rs',
    'app/src/test/java/FooTest.java',
    'spec/scope_spec.rb',
    'ScopeTests.cs',
    'tests/ScopeTest.php',
  ];
  const notTests = [
    'src/cli.ts',
    'tests/helpers.ts',
    'tests/conftest.py',
    'pkg/scope.go',
    'src/lib.rs',
    'app/src/main/java/Foo.java',
    'spec/spec_helper.rb',
    'src/checks/test-honesty/fixtures/asserts-own-mock.txt',
  ];
  for (const file of tests) assert.ok(isTestFile(file, DEFAULT_TEST_GLOBS), `${file} should be a test`);
  for (const file of notTests) assert.ok(!isTestFile(file, DEFAULT_TEST_GLOBS), `${file} should not be a test`);
});

test('scopeTestFiles normalizes, deduplicates, and preserves input order', () => {
  const scoped = scopeTestFiles(['tests/b.test.ts', './tests/a.test.ts', 'tests/b.test.ts', 'src/cli.ts'], DEFAULT_TEST_GLOBS);
  assert.deepEqual(scoped, ['tests/b.test.ts', 'tests/a.test.ts']);
});

test('absolute and repo-escaping explicit paths are dropped from the corpus', () => {
  const scoped = scopeTestFiles(['../outside.test.ts', 'a/../../escape.test.ts', '/etc/abs.test.ts', 'tests/a.test.ts'], DEFAULT_TEST_GLOBS);
  assert.deepEqual(scoped, ['tests/a.test.ts']);
});

function configDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aca-scope-'));
  if (config !== undefined) writeFileSync(join(dir, 'aca.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

test('no config file or no stanza yields the defaults', () => {
  assert.deepEqual(testFileGlobs(configDir()), [...DEFAULT_TEST_GLOBS]);
  assert.deepEqual(testFileGlobs(configDir({ include: ['**'] })), [...DEFAULT_TEST_GLOBS]);
});

test('a configured list replaces the defaults entirely', () => {
  const dir = configDir({ checks: { 'test-honesty': { testFiles: ['checks/**/*.check.ts'] } } });
  assert.deepEqual(testFileGlobs(dir), ['checks/**/*.check.ts']);
  assert.ok(!isTestFile('tests/cli.test.ts', testFileGlobs(dir)), 'defaults must not leak through an override');
});

test('an empty or malformed list is a ConfigError, never a silent gate-disable', () => {
  assert.throws(() => testFileGlobs(configDir({ checks: { 'test-honesty': { testFiles: [] } } })), ConfigError);
  assert.throws(() => testFileGlobs(configDir({ checks: { 'test-honesty': { testFiles: ['a', 7] } } })), ConfigError);
  assert.throws(() => testFileGlobs(configDir({ checks: { 'test-honesty': { testFiles: [''] } } })), ConfigError);
  assert.throws(() => testFileGlobs(configDir({ checks: { 'test-honesty': { testFiles: 'tests/**' } } })), ConfigError);
  assert.throws(() => testFileGlobs(configDir('{not json')), ConfigError);
});
