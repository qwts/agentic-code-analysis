import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInstructionCorpus,
  resolveInstructionSession,
} from '../src/corpora/instructions/index.ts';
import {
  fakeEstimator,
  fixtureRoot,
  locators,
  memoryFileSystem,
  possibleLocators,
} from './instruction-corpus-helpers.ts';

const request = {
  repoRoot: fixtureRoot('windsurf/repo'),
  userRoots: [{ id: 'user', path: fixtureRoot('windsurf/home') }],
};

test('windsurf rules: .devin shadows .windsurf per level, triggers map, global rules load first', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  assert.ok(!corpus.files.some((file) => file.path === '.windsurf/rules/shadowed.md'));
  assert.ok(corpus.diagnostics.some(
    (d) => d.locator === 'repo:.windsurf/rules/shadowed.md' && /shadowed by \.devin/.test(d.message),
  ));

  const idle = resolveInstructionSession(corpus, { profile: 'cascade-legacy', cwd: '.' });
  const confirmed = locators(idle);
  assert.equal(confirmed[0], 'user:.codeium/windsurf/memories/global_rules.md', 'global rules first');
  assert.ok(confirmed.includes('repo:.devin/rules/always.md'));
  assert.ok(confirmed.includes('repo:AGENTS.md'), 'root AGENTS.md is always on');
  const decideMetadata = idle.contributions.find(
    (entry) => entry.locator === 'repo:.devin/rules/decide.md' && entry.convention === 'windsurf/rule-metadata',
  );
  assert.ok(decideMetadata, 'model-decision rule always charges its description');
  assert.ok(idle.possibleAdditional.some(
    (entry) => entry.locator === 'repo:.devin/rules/decide.md' && entry.convention === 'windsurf/rule-model-decision',
  ));
  assert.ok(possibleLocators(idle).includes('repo:pkg/agents.md'),
    'nested agents.md (case-insensitive) scopes to its subtree');

  const untriggered = idle.possibleAdditional.find((entry) => entry.locator === 'repo:.devin/rules/untriggered.md');
  assert.ok(untriggered, 'a rule with no trigger has no documented default');
  assert.equal(idle.complete, false);

  const touched = resolveInstructionSession(corpus, {
    profile: 'cascade-legacy',
    cwd: '.',
    touchedPaths: ['pkg/main.go'],
  });
  assert.ok(locators(touched).includes('repo:pkg/.windsurf/rules/scoped.md'),
    'glob trigger fires for a matching touched path');
  assert.ok(locators(touched).includes('repo:pkg/agents.md'));
});

test('windsurf legacy .windsurfrules and skills follow the metadata/body split', async () => {
  const corpus = await discoverInstructionCorpus(request, { estimator: fakeEstimator });

  const legacy = corpus.files.find((file) => file.path === '.windsurfrules');
  assert.ok(legacy);
  assert.equal(legacy!.bindings[0]!.semantics.status, 'legacy');

  const idle = resolveInstructionSession(corpus, { profile: 'devin-local', cwd: '.' });
  assert.ok(!locators(idle).includes('repo:.windsurfrules'));
  assert.ok(possibleLocators(idle).includes('repo:.windsurfrules'));

  const skillMetadata = idle.contributions.find(
    (entry) => entry.locator === 'repo:.windsurf/skills/fmt/SKILL.md' && entry.convention === 'windsurf/skill-metadata',
  );
  assert.ok(skillMetadata, 'skill name+description charge every session');
  assert.ok(idle.possibleAdditional.some(
    (entry) => entry.locator === 'repo:.windsurf/skills/fmt/scripts/run.sh' && entry.convention === 'windsurf/skill-resource',
  ), 'supporting files appear as on-demand resources');
  assert.ok(idle.possibleAdditional.some(
    (entry) => entry.locator === 'repo:.windsurf/skills/fmt/SKILL.md' && entry.convention === 'windsurf/skill-body',
  ));

  const invoked = resolveInstructionSession(corpus, {
    profile: 'devin-local',
    cwd: '.',
    modelSelected: ['repo:.windsurf/skills/fmt/SKILL.md'],
  });
  assert.ok(invoked.contributions.some((entry) => entry.convention === 'windsurf/skill-body'));
});

test('windsurf workspace rules over the 12k-char cap charge only the documented prefix', async () => {
  const body = 'word '.repeat(3000);
  const fs = memoryFileSystem({
    '/repo': { '.devin/rules/big.md': `---\ntrigger: always_on\n---\n${body}` },
  });
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: fs },
  );
  const file = corpus.files.find((entry) => entry.path === '.devin/rules/big.md')!;
  const binding = file.bindings.find((entry) => entry.profile === 'cascade-legacy')!;
  assert.equal(binding.charged.kind, 'prefix');
  assert.deepEqual(binding.charged.limit, { unit: 'chars', value: 12_000 });
  assert.equal(binding.charged.text.length, 12_000);
  assert.ok(binding.charged.tokens.count < file.fullFile.count);
});
