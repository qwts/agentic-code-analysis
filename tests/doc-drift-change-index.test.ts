import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/core/config.ts';
import { buildChangeIndex } from '../src/checks/doc-drift/change-index.ts';

const all = (paths: string[]) => paths;

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-index-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(root, 'src/gone.ts'), 'export const removedSymbol = 1;\n');
  writeFileSync(join(root, 'src/old-name.ts'), 'export const renamedThing = 1;\n');
  writeFileSync(join(root, 'src/edited.ts'), 'export const before = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  return { root, git };
}

test('the index records modified, added, deleted, and both sides of a rename', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/edited.ts'), 'export const after = 2;\n');
  writeFileSync(join(root, 'src/fresh.ts'), 'export const fresh = 1;\n');
  rmSync(join(root, 'src/gone.ts'));
  git('mv', 'src/old-name.ts', 'src/new-name.ts');
  git('add', '.');

  const index = buildChangeIndex(root, 'main', ['src/edited.ts', 'src/fresh.ts', 'src/new-name.ts'], all);

  assert.equal(index.get('src/edited.ts')!.status, 'modified');
  assert.match(index.get('src/edited.ts')!.base!, /before/);
  assert.match(index.get('src/edited.ts')!.head!, /after/);
  assert.equal(index.get('src/fresh.ts')!.status, 'added');
  assert.equal(index.get('src/gone.ts')!.status, 'deleted');
  assert.match(index.get('src/gone.ts')!.base!, /removedSymbol/);
  assert.equal(index.get('src/gone.ts')!.head, undefined);
  const renamed = index.get('src/old-name.ts')!;
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.renamedTo, 'src/new-name.ts');
  assert.equal(index.get('src/new-name.ts')!.status, 'modified');
});

test('added and modified referents come only from the seeds; gone paths honor the global scope filter', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/edited.ts'), 'export const after = 2;\n');
  rmSync(join(root, 'src/gone.ts'));
  git('add', '.');

  // No seeds: the diffed modification must not become a referent by itself.
  const unseeded = buildChangeIndex(root, 'main', [], all);
  assert.equal(unseeded.get('src/edited.ts'), undefined);
  assert.equal(unseeded.get('src/gone.ts')!.status, 'deleted');

  // A scope filter that drops the deletion keeps it out of the index.
  const filtered = buildChangeIndex(root, 'main', [], () => []);
  assert.equal(filtered.get('src/gone.ts'), undefined);
});

test('a seed outside the diff is a seeded referent with head content; unreadable stays distinguishable from deleted', () => {
  const { root } = tempRepo();
  const index = buildChangeIndex(root, 'main', ['src/kept.ts', 'src/never-existed.ts'], all);
  assert.equal(index.get('src/kept.ts')!.status, 'seeded');
  assert.match(index.get('src/kept.ts')!.head!, /kept/);
  const missing = index.get('src/never-existed.ts')!;
  assert.equal(missing.status, 'seeded');
  assert.equal(missing.unreadable, true);
});

test('an unresolvable merge-base is a run-level ConfigError', () => {
  const { root } = tempRepo();
  assert.throws(() => buildChangeIndex(root, 'no-such-ref', [], all), ConfigError);
});
