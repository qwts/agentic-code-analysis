import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInstructionCorpus,
  resolveInstructionSession,
} from '../src/corpora/instructions/index.ts';
import { fakeEstimator, fixtureRoot, locators, memoryFileSystem } from './instruction-corpus-helpers.ts';

const request = {
  repoRoot: fixtureRoot('codex/repo'),
  userRoots: [{ id: 'user', path: fixtureRoot('codex/home') }],
};

test('codex chain: global first, root-to-CWD order, override wins per directory, empty files skipped', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  const codexBound = corpus.files
    .filter((file) => file.bindings.some((binding) => binding.tool === 'codex'))
    .map((file) => file.locator);
  assert.ok(codexBound.includes('user:.codex/AGENTS.md'));
  assert.ok(codexBound.includes('repo:AGENTS.md'));
  assert.ok(codexBound.includes('repo:pkg/AGENTS.override.md'));
  assert.ok(codexBound.includes('repo:pkg/deep/AGENTS.md'));
  // Other tools may still bind these files; codex itself never does.
  assert.ok(!codexBound.includes('repo:pkg/AGENTS.md'), 'shadowed sibling never binds for codex');
  assert.ok(!codexBound.includes('repo:empty/AGENTS.md'), 'empty files are skipped by codex');
  assert.ok(corpus.diagnostics.some((d) => d.locator === 'repo:pkg/AGENTS.md' && /shadowed/.test(d.message)));
  assert.ok(corpus.diagnostics.some((d) => d.locator === 'repo:empty/AGENTS.md' && /empty/.test(d.message)));

  const deep = resolveInstructionSession(corpus, { profile: 'codex-local', cwd: 'pkg/deep' });
  assert.deepEqual(locators(deep), [
    'user:.codex/AGENTS.md',
    'repo:AGENTS.md',
    'repo:pkg/AGENTS.override.md',
    'repo:pkg/deep/AGENTS.md',
  ]);
  assert.equal(deep.complete, true, 'a fully verified chain with no conditionals is deterministic');
  const expected = deep.contributions.reduce((sum, entry) => sum + entry.charged.count, 0);
  assert.equal(deep.confirmedTokens.count, expected, 'total equals its charged segments');
  assert.equal(deep.confirmedTokens.estimator, 'fake-words@1');

  const root = resolveInstructionSession(corpus, { profile: 'codex-local', cwd: '.' });
  assert.deepEqual(locators(root), ['user:.codex/AGENTS.md', 'repo:AGENTS.md'],
    'directories outside the CWD chain are deterministically absent, not conditional');
  assert.equal(root.possibleAdditional.length, 0);
});

test('codex project_doc_max_bytes: files charged whole in order until the next would cross the cap', async () => {
  const corpus = await discoverInstructionCorpus(
    { ...request, config: { codexProjectDocMaxBytes: 60 } },
    { estimator: fakeEstimator },
  );
  const deep = resolveInstructionSession(corpus, { profile: 'codex-local', cwd: 'pkg/deep' });
  // Global (25 B) + root (31 B) fit; pkg override (27 B) would cross 60.
  assert.deepEqual(locators(deep), ['user:.codex/AGENTS.md', 'repo:AGENTS.md']);
  assert.ok(deep.diagnostics.some((line) => /project_doc_max_bytes/.test(line)));
});

test('codex cap stops the chain: a closer file that would individually fit never sneaks back in', async () => {
  const fs = memoryFileSystem({
    '/repo': {
      'AGENTS.md': 'a'.repeat(40),
      'pkg/AGENTS.md': 'b'.repeat(50),
      'pkg/deep/AGENTS.md': 'c'.repeat(5),
    },
  });
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo', config: { codexProjectDocMaxBytes: 60 } },
    { estimator: fakeEstimator, fileSystem: fs },
  );
  const deep = resolveInstructionSession(corpus, { profile: 'codex-local', cwd: 'pkg/deep' });
  // pkg/AGENTS.md crosses the cap (40+50 > 60); codex stops adding files
  // there, so the tiny deep file (40+5 <= 60) must still be excluded.
  assert.deepEqual(locators(deep), ['repo:AGENTS.md']);
  assert.equal(
    deep.diagnostics.filter((line) => /project_doc_max_bytes/.test(line)).length,
    2,
    'both the crossing file and the rest of the chain are reported',
  );
});

test('codex fallback filenames only bind when configured, and lose to AGENTS.md in the same directory', async () => {
  const withoutFallback = await discoverInstructionCorpus(request, { estimator: fakeEstimator });
  assert.ok(!withoutFallback.files.some((file) => file.path.endsWith('TEAM_GUIDE.md')));

  const withFallback = await discoverInstructionCorpus(
    { ...request, config: { codexFallbackFilenames: ['TEAM_GUIDE.md'] } },
    { estimator: fakeEstimator },
  );
  // pkg/deep has both AGENTS.md and TEAM_GUIDE.md; AGENTS.md wins the slot.
  assert.ok(!withFallback.files.some((file) => file.path === 'pkg/deep/TEAM_GUIDE.md'));
  assert.ok(withFallback.diagnostics.some(
    (d) => d.locator === 'repo:pkg/deep/TEAM_GUIDE.md' && /shadowed/.test(d.message),
  ));
});
