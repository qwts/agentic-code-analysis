import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeFacts, importedBy, importSpecifiers, importsOf, resolveSpecifier } from '../src/checks/context-footprint/derive.ts';

test('importSpecifiers finds static, bare, re-export, and dynamic forms', () => {
  const content = `import { a } from './a.ts';
import type { B } from '../b/types.ts';
import 'polyfill';
export { c } from './c.ts';
const d = await import('./d.ts');`;
  assert.deepEqual(importSpecifiers(content), ['./a.ts', '../b/types.ts', 'polyfill', './c.ts', './d.ts']);
});

test('resolveSpecifier: relative resolves against the importer, bare stays put', () => {
  assert.equal(resolveSpecifier('src/checks/x/index.ts', '../../core/config.ts'), 'src/core/config.ts');
  assert.equal(resolveSpecifier('src/x.ts', '@anthropic-ai/sdk'), '@anthropic-ai/sdk');
});

test('importsOf dedupes and sorts', () => {
  const content = `import { a } from './z.ts';\nimport { b } from './z.ts';\nimport { c } from './a.ts';`;
  assert.deepEqual(importsOf('src/x.ts', content), ['src/a.ts', 'src/z.ts']);
});

test('importedBy finds importers with and without extension in the specifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'aca-derive-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/target.ts'), 'export const t = 1;');
  writeFileSync(join(root, 'src/user-ext.ts'), `import { t } from './target.ts';`);
  writeFileSync(join(root, 'src/user-bare.ts'), `import { t } from './target';`);
  writeFileSync(join(root, 'src/unrelated.ts'), `import { x } from './other.ts';`);
  const files = ['src/target.ts', 'src/user-ext.ts', 'src/user-bare.ts', 'src/unrelated.ts'];
  assert.deepEqual(importedBy(root, 'src/target.ts', files), ['src/user-bare.ts', 'src/user-ext.ts']);
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-cf-repo-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), 'line1\nline2\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  return root;
}

test('changeFacts: grown file gets hunks and a growth line vs the base', () => {
  const root = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'line1\nline2\nline3\nline4\n');
  const content = 'line1\nline2\nline3\nline4\n';
  const facts = changeFacts(root, 'main', 'a.ts', content);
  assert.match(facts.growth, /grew from 3 to 5 lines/);
  assert.match(facts.hunks, /@@/);
});

test('changeFacts: untracked file reports as new', () => {
  const root = tempRepo();
  const facts = changeFacts(root, 'main', 'b.ts', 'x\n');
  assert.match(facts.growth, /new file, 2 lines/);
});

test('changeFacts: unresolvable base degrades to a no-base line', () => {
  const root = tempRepo();
  const facts = changeFacts(root, 'no-such-ref', 'a.ts', 'x\n');
  assert.match(facts.growth, /no diff base/);
  assert.equal(facts.hunks, '');
});
