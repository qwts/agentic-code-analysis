import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInstructionCorpus,
  resolveInstructionSession,
} from '../src/corpora/instructions/index.ts';
import { fakeEstimator, fixtureRoot, locators, possibleLocators } from './instruction-corpus-helpers.ts';

const request = { repoRoot: fixtureRoot('cursor/repo') };

test('cursor .mdc activation modes map to the four documented rule types', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });
  const idle = resolveInstructionSession(corpus, { profile: 'cursor-editor-agent', cwd: '.' });

  assert.ok(locators(idle).includes('repo:.cursor/rules/always.mdc'), 'alwaysApply loads every session');
  const metadata = idle.contributions.find(
    (entry) => entry.locator === 'repo:.cursor/rules/smart.mdc' && entry.convention === 'cursor/project-rule-metadata',
  );
  assert.ok(metadata, 'agent-requested rule charges its description each session');
  assert.ok(possibleLocators(idle).includes('repo:.cursor/rules/auto.mdc'), 'glob rule waits for a match');
  assert.ok(possibleLocators(idle).includes('repo:.cursor/rules/manual.mdc'), 'manual rule waits for @-mention');

  const active = resolveInstructionSession(corpus, {
    profile: 'cursor-editor-agent',
    cwd: '.',
    touchedPaths: ['src/panel/App.tsx', 'pkg/db/schema.sql'],
    modelSelected: ['repo:.cursor/rules/smart.mdc'],
    invoked: ['repo:.cursor/rules/manual.mdc'],
  });
  assert.ok(locators(active).includes('repo:.cursor/rules/auto.mdc'));
  assert.ok(locators(active).includes('repo:.cursor/rules/manual.mdc'));
  assert.ok(active.contributions.some((entry) => entry.convention === 'cursor/project-rule-agent-requested'));
  assert.ok(locators(active).includes('repo:pkg/.cursor/rules/nested.mdc'),
    'nested rule globs are anchored to their subtree');

  const elsewhere = resolveInstructionSession(corpus, {
    profile: 'cursor-editor-agent',
    cwd: '.',
    touchedPaths: ['db/schema.sql'],
  });
  assert.ok(!locators(elsewhere).includes('repo:pkg/.cursor/rules/nested.mdc'),
    'a sql file outside pkg/ must not trigger the pkg-scoped rule');
});

test('cursor: plain .md in rules is ignored with a diagnostic; legacy .cursorrules is found but unverified', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });
  assert.ok(!corpus.files.some((file) => file.path === '.cursor/rules/ignored.md'));
  assert.ok(corpus.diagnostics.some(
    (d) => d.locator === 'repo:.cursor/rules/ignored.md' && /ignored unless/.test(d.message),
  ));

  const legacy = corpus.files.find((file) => file.path === '.cursorrules');
  assert.ok(legacy, 'legacy file stays in the corpus');
  assert.equal(legacy!.bindings[0]!.semantics.status, 'legacy');

  const loadSet = resolveInstructionSession(corpus, { profile: 'cursor-editor-agent', cwd: '.' });
  assert.ok(!locators(loadSet).includes('repo:.cursorrules'), 'unverified content never enters the confirmed total');
  const conditional = loadSet.possibleAdditional.find((entry) => entry.locator === 'repo:.cursorrules');
  assert.ok(conditional && /legacy/.test(conditional.condition ?? ''));
  assert.equal(loadSet.complete, false);
});

test('cursor CLI reads root AGENTS.md and CLAUDE.md; the editor profile does not bind CLAUDE.md', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  const cli = resolveInstructionSession(corpus, { profile: 'cursor-cli', cwd: '.' });
  assert.ok(locators(cli).includes('repo:AGENTS.md'));
  assert.ok(locators(cli).includes('repo:CLAUDE.md'));
  const cliAll = [...locators(cli), ...possibleLocators(cli)];
  assert.ok(!cliAll.includes('repo:.cursorrules'), 'CLI docs do not mention the legacy file');

  const editor = resolveInstructionSession(corpus, { profile: 'cursor-editor-agent', cwd: '.' });
  const editorAll = [...locators(editor), ...possibleLocators(editor)];
  assert.ok(!editorAll.includes('repo:CLAUDE.md'));
  assert.ok(possibleLocators(editor).includes('repo:pkg/AGENTS.md'),
    'nested AGENTS.md scopes to its subtree in the editor');
});
