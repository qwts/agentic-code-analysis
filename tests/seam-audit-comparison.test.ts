import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComparisons } from '../src/checks/seam-audit/comparison.ts';
import { ConfigError } from '../src/core/config.ts';

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-seam-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b;\n`);
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  git('branch', 'base');
  return { root, git };
}

test('added file is new; changed tracked file is legacy with the base content', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'c.ts'), 'export const c = Date.now();\n');
  git('add', 'c.ts');
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b + 1;\n`);
  const prepared = buildComparisons(root, 'main', ['a.ts', 'c.ts']);

  const c = prepared.get('c.ts')!;
  assert.ok(c.ok && c.comparison.kind === 'new');

  const a = prepared.get('a.ts')!;
  assert.ok(a.ok && a.comparison.kind === 'legacy');
  assert.match(a.comparison.base.content, /const a = b;/);
  assert.match(a.comparison.head.content, /const a = b \+ 1;/);
});

test('untracked file is new; unchanged tracked file is legacy with base equal to head', () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'untracked.ts'), 'export const u = 1;\n');
  const prepared = buildComparisons(root, 'main', ['untracked.ts', 'b.ts']);
  const untracked = prepared.get('untracked.ts')!;
  assert.ok(untracked.ok && untracked.comparison.kind === 'new');
  const b = prepared.get('b.ts')!;
  assert.ok(b.ok && b.comparison.kind === 'legacy');
  assert.equal(b.comparison.base.content, b.comparison.head.content);
});

test('a rename stays legacy under its base path; a copy is new', () => {
  const { root, git } = tempRepo();
  renameSync(join(root, 'a.ts'), join(root, 'renamed.ts'));
  writeFileSync(join(root, 'copy.ts'), 'export const b = 1;\nexport const extra = 2;\n');
  git('add', '-A');
  const prepared = buildComparisons(root, 'main', ['renamed.ts', 'copy.ts']);

  const renamed = prepared.get('renamed.ts')!;
  assert.ok(renamed.ok && renamed.comparison.kind === 'legacy');
  assert.equal(renamed.comparison.base.path, 'a.ts');
  assert.equal(renamed.comparison.head.path, 'renamed.ts');

  const copy = prepared.get('copy.ts')!;
  assert.ok(copy.ok && copy.comparison.kind === 'new');
});

test('unreadable head degrades per file, never crashes and never infers new', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'changed\n');
  git('commit', '-am', 'change', '--quiet');
  unlinkSync(join(root, 'a.ts'));
  const prepared = buildComparisons(root, 'main', ['a.ts']);
  const a = prepared.get('a.ts')!;
  assert.ok(!a.ok);
  assert.equal(a.note, 'unreadable');
});

test('unresolvable merge-base is a run-level ConfigError', () => {
  const { root } = tempRepo();
  assert.throws(() => buildComparisons(root, 'no-such-ref', ['a.ts']), ConfigError);
});

test('snapshots carry extracted dependencies and ambient candidates', () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = () => b + Date.now();\n`);
  const prepared = buildComparisons(root, 'main', ['a.ts']);
  const a = prepared.get('a.ts')!;
  assert.ok(a.ok && a.comparison.kind === 'legacy');
  assert.deepEqual(a.comparison.head.dependencies, ['b.ts']);
  assert.deepEqual(a.comparison.head.candidates, ['Date (clock)']);
  assert.deepEqual(a.comparison.base.candidates, []);
});
