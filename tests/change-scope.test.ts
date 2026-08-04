import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, filterScope, repoRoot } from '../src/core/change-scope.ts';

test('filterScope applies include then exclude globs', () => {
  const files = ['src/a.ts', 'src/deep/b.ts', 'docs/c.md', 'src/generated/d.ts'];
  assert.deepEqual(filterScope(files, { include: ['src/**'], exclude: ['src/generated/**'] }), [
    'src/a.ts',
    'src/deep/b.ts',
  ]);
  assert.deepEqual(filterScope(files, { include: ['**'], exclude: [] }), files);
  assert.deepEqual(filterScope(files, { include: ['nomatch/**'], exclude: [] }), []);
});

test('changedFiles diffs working tree against the merge-base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aca-scope-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'base.ts'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'committed.ts'), 'committed\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feature work');
  writeFileSync(join(dir, 'uncommitted.ts'), 'uncommitted\n');
  git('add', 'uncommitted.ts');
  writeFileSync(join(dir, 'base.ts'), 'modified\n');

  assert.equal(repoRoot(dir), execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim());
  assert.deepEqual(changedFiles('main', dir).sort(), ['base.ts', 'committed.ts', 'uncommitted.ts']);
});
