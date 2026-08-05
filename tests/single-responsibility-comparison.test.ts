import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComparisons, growthLine, type Comparison, type Prepared } from '../src/checks/single-responsibility/comparison.ts';
import { ConfigError } from '../src/core/config.ts';

// Base commit is pinned on the `base` branch; changes then land on main (or
// the working tree), so merge-base(base, HEAD) always resolves to the pin.
function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-srp-cmp-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'target.ts'), 'export const t = 1;\n');
  writeFileSync(join(root, 'user.ts'), `import { t } from './target.ts';\nexport const u = t;\n`);
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  git('branch', 'base');
  return { root, git };
}

function comparison(prepared: Prepared): Comparison {
  assert.ok(prepared.ok, 'expected a prepared comparison');
  return prepared.comparison;
}

test('growthLine: new, grown, shrunk, unchanged', () => {
  assert.equal(growthLine(undefined, 'a\n'), 'new file, 1 lines');
  assert.equal(growthLine('a\n', 'a\nb\nc\n'), 'grew from 1 to 3 lines');
  assert.equal(growthLine('a\nb\nc\n', 'a\n'), 'shrank from 3 to 1 lines');
  assert.equal(growthLine('a\n', 'a\n'), 'unchanged at 1 lines');
});

test('modified file is legacy with real base and head snapshots', () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'target.ts'), 'export const t = 1;\nexport const t2 = 2;\n');
  const c = comparison(buildComparisons(root, 'base', ['target.ts']).get('target.ts')!);
  assert.equal(c.kind, 'legacy');
  assert.ok(c.kind === 'legacy');
  assert.equal(c.base.content, 'export const t = 1;\n');
  assert.match(c.head.content, /t2/);
  assert.equal(c.growth, 'grew from 1 to 2 lines');
  assert.deepEqual(c.base.importedBy, ['user.ts']);
  assert.deepEqual(c.head.importedBy, ['user.ts']);
});

test('untracked and committed additions are new; unchanged files are legacy', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'untracked.ts'), 'export const n = 1;\n');
  writeFileSync(join(root, 'committed.ts'), 'export const c = 1;\n');
  git('add', 'committed.ts');
  git('commit', '-m', 'add', '--quiet');
  const prepared = buildComparisons(root, 'base', ['untracked.ts', 'committed.ts', 'target.ts']);
  assert.equal(comparison(prepared.get('untracked.ts')!).kind, 'new');
  assert.equal(comparison(prepared.get('committed.ts')!).kind, 'new');
  const unchanged = comparison(prepared.get('target.ts')!);
  assert.equal(unchanged.kind, 'legacy');
  assert.equal(unchanged.growth, 'unchanged at 1 lines');
});

test('a rename stays legacy and preserves the base path; a copy stays new', () => {
  const { root, git } = tempRepo();
  git('mv', 'target.ts', 'renamed.ts');
  git('commit', '-m', 'rename', '--quiet');
  const c = comparison(buildComparisons(root, 'base', ['renamed.ts']).get('renamed.ts')!);
  assert.ok(c.kind === 'legacy');
  assert.equal(c.base.path, 'target.ts');
  assert.equal(c.head.path, 'renamed.ts');
});

test('deleted importers are represented in the base graph, absent from head', () => {
  const { root, git } = tempRepo();
  git('rm', '--quiet', 'user.ts');
  git('commit', '-m', 'drop importer', '--quiet');
  writeFileSync(join(root, 'target.ts'), 'export const t = 2;\n');
  const c = comparison(buildComparisons(root, 'base', ['target.ts']).get('target.ts')!);
  assert.ok(c.kind === 'legacy');
  assert.deepEqual(c.base.importedBy, ['user.ts']);
  assert.deepEqual(c.head.importedBy, []);
});

test('changed non-code files never enter the base import graph', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'notes.md'), `import { t } from './target.ts';\n`);
  git('add', 'notes.md');
  git('commit', '-m', 'doc with import-looking text', '--quiet');
  git('branch', '-f', 'base');
  writeFileSync(join(root, 'notes.md'), 'rewritten\n');
  git('commit', '-am', 'edit doc', '--quiet');
  writeFileSync(join(root, 'target.ts'), 'export const t = 2;\n');
  const c = comparison(buildComparisons(root, 'base', ['target.ts']).get('target.ts')!);
  assert.ok(c.kind === 'legacy');
  assert.deepEqual(c.base.importedBy, ['user.ts'], 'notes.md must not be a phantom base importer');
  assert.deepEqual(c.head.importedBy, ['user.ts']);
});

test('unreadable head degrades per file; unresolvable merge-base throws ConfigError', () => {
  const { root } = tempRepo();
  unlinkSync(join(root, 'user.ts'));
  const prepared = buildComparisons(root, 'base', ['user.ts']).get('user.ts')!;
  assert.deepEqual(prepared, { ok: false, note: 'unreadable' });
  assert.throws(() => buildComparisons(root, 'no-such-ref', ['target.ts']), ConfigError);
});
