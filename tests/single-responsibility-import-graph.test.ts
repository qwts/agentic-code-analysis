import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImporterIndex, importedBy, importSpecifiers, importsOf, readContents, resolveSpecifier } from '../src/checks/single-responsibility/import-graph.ts';

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

test('readContents reads code files only and skips unreadable entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'aca-srp-graph-'));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
  writeFileSync(join(root, 'notes.md'), '# not code');
  const contents = readContents(root, ['a.ts', 'notes.md', 'missing.ts']);
  assert.deepEqual([...contents.keys()], ['a.ts']);
  assert.equal(contents.get('a.ts'), 'export const a = 1;');
});

test('importedBy resolves importers via the prebuilt index, with and without extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'aca-srp-graph-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/target.ts'), 'export const t = 1;');
  writeFileSync(join(root, 'src/user-ext.ts'), `import { t } from './target.ts';`);
  writeFileSync(join(root, 'src/user-bare.ts'), `import { t } from './target';`);
  writeFileSync(join(root, 'src/unrelated.ts'), `import { x } from './other.ts';`);
  const index = buildImporterIndex(readContents(root, ['src/target.ts', 'src/user-ext.ts', 'src/user-bare.ts', 'src/unrelated.ts']));
  assert.deepEqual(importedBy(index, 'src/target.ts'), ['src/user-bare.ts', 'src/user-ext.ts']);
});

test('importedBy matches explicit ./-prefixed paths to repo-relative importers', () => {
  const root = mkdtempSync(join(tmpdir(), 'aca-srp-graph-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/target.ts'), 'export const t = 1;');
  writeFileSync(join(root, 'src/user.ts'), `import { t } from './target.ts';`);
  const index = buildImporterIndex(readContents(root, ['src/target.ts', 'src/user.ts']));
  assert.deepEqual(importedBy(index, './src/target.ts'), ['src/user.ts']);
});

test('buildImporterIndex works over an arbitrary contents map, no disk needed', () => {
  const index = buildImporterIndex(
    new Map([
      ['src/user.ts', `import { t } from './target.ts';`],
      ['src/target.ts', 'export const t = 1;'],
    ]),
  );
  assert.deepEqual(importedBy(index, 'src/target.ts'), ['src/user.ts']);
});
