import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/core/config.ts';
import { discoverDocs, isInstructionFile, loadDocDriftScope } from '../src/checks/doc-drift/scope.ts';

function tempTree(files: string[], config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-docscope-'));
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), `# ${file}\n`);
  }
  if (config !== undefined) writeFileSync(join(root, 'aca.config.json'), JSON.stringify(config));
  return root;
}

test('defaults apply without a config file or without a doc-drift section', () => {
  const root = tempTree([]);
  assert.deepEqual(loadDocDriftScope(root), { include: ['README.md', 'docs/**/*.md'], exclude: [] });
  const withOther = tempTree([], { include: ['src/**'] });
  assert.deepEqual(loadDocDriftScope(withOther).include, ['README.md', 'docs/**/*.md']);
});

test('a configured include replaces the default; malformed or empty scope is a ConfigError', () => {
  const root = tempTree([], { checks: { 'doc-drift': { include: ['guides/**/*.md'], exclude: ['guides/tmp/**'] } } });
  assert.deepEqual(loadDocDriftScope(root), { include: ['guides/**/*.md'], exclude: ['guides/tmp/**'] });
  assert.throws(() => loadDocDriftScope(tempTree([], { checks: { 'doc-drift': { include: [] } } })), ConfigError);
  assert.throws(() => loadDocDriftScope(tempTree([], { checks: { 'doc-drift': { include: 'README.md' } } })), ConfigError);
  assert.throws(() => loadDocDriftScope(tempTree([], { checks: { 'doc-drift': [] } })), ConfigError);
});

test('discovery matches globs against tracked paths and hard-excludes instruction files', () => {
  const tracked = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/a.md', 'docs/deep/b.md', 'docs/AGENTS.md', 'src/notes.md'];
  const root = tempTree([]);
  assert.deepEqual(discoverDocs(tracked, loadDocDriftScope(root)), ['README.md', 'docs/a.md', 'docs/deep/b.md']);
});

test('untracked docs never enter the corpus: they cannot bill a judge call or fail a run', () => {
  const root = tempTree([]);
  // The working tree holds docs/scratch.md, but git does not track it.
  const tracked = ['README.md', 'docs/a.md'];
  assert.deepEqual(discoverDocs(tracked, loadDocDriftScope(root)), ['README.md', 'docs/a.md']);
  assert.ok(!discoverDocs(tracked, loadDocDriftScope(root)).includes('docs/scratch.md'));
});

test('instruction corpora are excluded at any depth regardless of globs', () => {
  assert.ok(isInstructionFile('AGENTS.md'));
  assert.ok(isInstructionFile('docs/CLAUDE.md'));
  assert.ok(isInstructionFile('.claude/commands/x.md'));
  assert.ok(isInstructionFile('sub/.cursor/rules.md'));
  assert.ok(isInstructionFile('.github/copilot-instructions.md'));
  assert.ok(isInstructionFile('.github/instructions/build.md'));
  assert.ok(!isInstructionFile('docs/agents-overview.md'));
});
