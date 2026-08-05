import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInstructionCorpus,
  resolveInstructionSession,
  type InstructionCorpus,
} from '../src/corpora/instructions/index.ts';
import { fakeEstimator, fixtureRoot, locators, possibleLocators } from './instruction-corpus-helpers.ts';

const request = {
  repoRoot: fixtureRoot('claude/repo'),
  userRoots: [{ id: 'user', path: fixtureRoot('claude/home') }],
  config: { claudeAutoMemoryDir: 'user:mem' },
};

async function corpus(): Promise<InstructionCorpus> {
  return discoverInstructionCorpus(request, { estimator: fakeEstimator });
}

test('claude memory: user before project, comment-stripped charge, local after CLAUDE.md, imports expand', async () => {
  const mapped = await corpus();
  const loadSet = resolveInstructionSession(mapped, { profile: 'claude-local', cwd: '.' });

  const confirmed = locators(loadSet);
  const order = (locator: string): number => confirmed.indexOf(locator);
  assert.ok(order('user:.claude/CLAUDE.md') !== -1);
  assert.ok(order('user:.claude/CLAUDE.md') < order('repo:CLAUDE.md'), 'user scope loads first');
  assert.ok(order('user:.claude/rules/user.md') < order('repo:.claude/rules/always.md'),
    'user rules before project rules');
  assert.ok(order('repo:CLAUDE.md') < order('repo:CLAUDE.local.md'), 'local file appended after CLAUDE.md');
  assert.ok(confirmed.includes('repo:docs/style.md'), 'in-repo import expands at launch');
  assert.ok(confirmed.includes('user:mem/MEMORY.md'), 'auto-memory index loads each session');

  const repoMemory = mapped.files.find((file) => file.locator === 'repo:CLAUDE.md')!;
  const charged = repoMemory.bindings.find((binding) => binding.profile === 'claude-local')!.charged;
  assert.equal(charged.kind, 'comment-stripped');
  assert.ok(!charged.text.includes('maintainer note'), 'block HTML comments are not charged');
  assert.ok(charged.text.includes('Project instructions.'));
  assert.ok(charged.tokens.count < repoMemory.fullFile.count, 'projection charges less than the raw file');
});

test('claude conditional loads: nested memory, path-scoped rules, skill bodies, commands, external imports', async () => {
  const mapped = await corpus();
  const idle = resolveInstructionSession(mapped, { profile: 'claude-local', cwd: '.' });

  const possible = possibleLocators(idle);
  assert.ok(possible.includes('repo:sub/CLAUDE.md'), 'below-CWD memory waits for a touch');
  assert.ok(possible.includes('repo:.claude/rules/scoped.md'), 'paths-scoped rule waits for a match');
  assert.ok(possible.includes('user:shared.md'), 'project-scope external import is approval-gated');
  assert.ok(possible.includes('user:mem/topic.md'), 'auto-memory topics load on demand');
  assert.equal(idle.complete, false, 'conditional contributions make the total a floor');
  const skillBody = idle.possibleAdditional.find(
    (entry) => entry.locator === 'repo:.claude/skills/deploy/SKILL.md' && entry.convention === 'claude-code/skill-body',
  );
  assert.ok(skillBody, 'skill body is conditional');
  assert.ok(locators(idle).includes('repo:.claude/skills/deploy/SKILL.md'),
    'skill metadata is charged every session');
  const metadata = idle.contributions.find((entry) => entry.convention === 'claude-code/skill-metadata')!;
  assert.ok(metadata.charged.count < skillBody!.charged.count + metadata.charged.count);

  const active = resolveInstructionSession(mapped, {
    profile: 'claude-local',
    cwd: '.',
    touchedPaths: ['sub/service.ts', 'src/api/users.ts'],
    modelSelected: ['repo:.claude/skills/deploy/SKILL.md'],
    invoked: ['repo:.claude/commands/ship.md'],
    acceptedExternalImports: ['user:shared.md'],
  });
  const nowConfirmed = locators(active);
  assert.ok(nowConfirmed.includes('repo:sub/CLAUDE.md'));
  assert.ok(nowConfirmed.includes('repo:.claude/rules/scoped.md'));
  assert.ok(nowConfirmed.includes('user:shared.md'));
  assert.ok(active.contributions.some((entry) => entry.convention === 'claude-code/skill-body'));
  assert.ok(active.contributions.some((entry) => entry.convention === 'claude-code/command-body'));
  assert.ok(active.confirmedTokens.count > idle.confirmedTokens.count);
});

test('claude disable-model-invocation: no description in context, body only on explicit invocation', async () => {
  const mapped = await corpus();
  const skillFile = mapped.files.find(
    (file) => file.locator === 'repo:.claude/skills/secret-tool/SKILL.md',
  );
  assert.ok(skillFile);
  assert.ok(
    !skillFile!.bindings.some((binding) => binding.convention === 'claude-code/skill-metadata'),
    'description must not charge at session start',
  );
  const body = skillFile!.bindings.find((binding) => binding.convention === 'claude-code/skill-body');
  assert.equal(body!.activation, 'on-invocation');

  const idle = resolveInstructionSession(mapped, { profile: 'claude-local', cwd: '.' });
  assert.ok(!locators(idle).includes('repo:.claude/skills/secret-tool/SKILL.md'));
  const invoked = resolveInstructionSession(mapped, {
    profile: 'claude-local',
    cwd: '.',
    invoked: ['repo:.claude/skills/secret-tool/SKILL.md'],
  });
  assert.ok(locators(invoked).includes('repo:.claude/skills/secret-tool/SKILL.md'));
});

test('claude-cloud sessions pay for repository files only', async () => {
  const mapped = await corpus();
  const cloud = resolveInstructionSession(mapped, { profile: 'claude-cloud', cwd: '.' });
  const all = [...locators(cloud), ...possibleLocators(cloud)];
  assert.ok(all.length > 0);
  assert.ok(all.every((locator) => locator.startsWith('repo:')),
    `cloud sessions must not charge user-root files, got: ${all.join(', ')}`);
  assert.ok(locators(cloud).includes('repo:CLAUDE.md'));
});

test('claude starting in a subdirectory loads that directory chain at launch', async () => {
  const mapped = await corpus();
  const inSub = resolveInstructionSession(mapped, { profile: 'claude-local', cwd: 'sub' });
  assert.ok(locators(inSub).includes('repo:sub/CLAUDE.md'),
    'files between the root and the CWD load at launch');
});
