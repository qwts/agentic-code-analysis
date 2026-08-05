import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInstructionCorpus,
  resolveInstructionSession,
} from '../src/corpora/instructions/index.ts';
import { fakeEstimator, fixtureRoot, locators, possibleLocators } from './instruction-corpus-helpers.ts';

const request = {
  repoRoot: fixtureRoot('copilot/repo'),
  userRoots: [{ id: 'user', path: fixtureRoot('copilot/home') }],
};

test('copilot surfaces differ: CLI sees user + all agent files, code review sees root AGENTS.md only', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  const cli = resolveInstructionSession(corpus, { profile: 'copilot-cli', cwd: '.' });
  const cliAll = [...locators(cli), ...possibleLocators(cli)];
  assert.ok(locators(cli).includes('repo:.github/copilot-instructions.md'));
  assert.ok(locators(cli).includes('repo:AGENTS.md'));
  assert.ok(locators(cli).includes('repo:CLAUDE.md'));
  assert.ok(locators(cli).includes('repo:GEMINI.md'));
  assert.ok(locators(cli).includes('user:.copilot/copilot-instructions.md'));
  assert.ok(cliAll.includes('repo:pkg/AGENTS.md'), 'nested agent file is at least conditional for the CLI');

  const review = resolveInstructionSession(corpus, { profile: 'copilot-code-review', cwd: '.' });
  const reviewAll = [...locators(review), ...possibleLocators(review)];
  assert.ok(locators(review).includes('repo:.github/copilot-instructions.md'));
  assert.ok(locators(review).includes('repo:AGENTS.md'));
  assert.ok(!reviewAll.includes('repo:CLAUDE.md'), 'code review does not read CLAUDE.md');
  assert.ok(!reviewAll.includes('repo:GEMINI.md'));
  assert.ok(!reviewAll.includes('user:.copilot/copilot-instructions.md'));
  assert.ok(!reviewAll.includes('repo:pkg/AGENTS.md'), 'code review support is confirmed for root only');

  const cloud = resolveInstructionSession(corpus, { profile: 'copilot-cloud-agent', cwd: '.' });
  const cloudAll = [...locators(cloud), ...possibleLocators(cloud)];
  assert.ok(locators(cloud).includes('repo:CLAUDE.md'));
  assert.ok(!cloudAll.some((locator) => locator.startsWith('user:')),
    'user instructions are a CLI-only surface');
});

test('copilot path-specific instructions activate on applyTo glob matches and charge the body', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  const idle = resolveInstructionSession(corpus, { profile: 'copilot-cli', cwd: '.' });
  assert.ok(possibleLocators(idle).includes('repo:.github/instructions/api.instructions.md'));

  const active = resolveInstructionSession(corpus, {
    profile: 'copilot-cli',
    cwd: '.',
    touchedPaths: ['src/server.ts', 'tools/gen.py'],
  });
  assert.ok(locators(active).includes('repo:.github/instructions/api.instructions.md'));
  assert.ok(locators(active).includes('user:.copilot/instructions/perso.instructions.md'),
    'user path-specific instructions also match by glob');
  const pathInstructions = corpus.files.find(
    (file) => file.locator === 'repo:.github/instructions/api.instructions.md',
  )!;
  const binding = pathInstructions.bindings.find((entry) => entry.profile === 'copilot-cli')!;
  assert.equal(binding.charged.kind, 'body');
  assert.ok(!binding.charged.text.includes('applyTo'), 'frontmatter is not charged');
});

test('copilot instructions are combined without an invented precedence order', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });
  for (const file of corpus.files) {
    for (const binding of file.bindings) {
      if (binding.tool !== 'copilot') continue;
      assert.equal(binding.order.kind, 'unordered', `${file.locator} must stay unordered`);
      assert.equal(binding.conflict, 'combined-no-precedence');
    }
  }
});
