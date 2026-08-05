import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtifact, serializePayload, slice } from '../src/checks/agent-rule-conflict/artifact.ts';
import { binding, corpus, file } from './agent-rule-conflict-helpers.ts';

const ROOT = file('AGENTS.md', 'Use npm only.', [binding({ profile: 'codex-local', text: 'Use npm only.' })]);
const NESTED = file('pkg/AGENTS.md', 'Prototype freely.', [
  binding({
    profile: 'codex-local',
    text: 'Prototype freely.',
    scope: { kind: 'directory-subtree', directory: 'pkg', via: 'cwd' },
    order: { kind: 'ordered', rule: 'root to CWD', rank: 2 },
  }),
]);

test('projection: sources sorted, sessions coalesce identical load sets across cwds', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED]), []);
  assert.deepEqual(artifact.sources.map((s) => s.id), ['repo:AGENTS.md', 'repo:pkg/AGENTS.md']);
  // Root CWD loads only the root file; pkg CWD loads both — two classes.
  assert.deepEqual(
    artifact.sessions.map((s) => [s.id, s.confirmed.map((e) => e.sourceId)]),
    [
      ['codex-local@.', ['repo:AGENTS.md']],
      ['codex-local@pkg', ['repo:AGENTS.md', 'repo:pkg/AGENTS.md']],
    ],
  );
  assert.equal(artifact.sessions[1]!.confirmed[1]!.conflict, 'closer-overrides');
});

test('projection: identical membership coalesces into one class listing every cwd', () => {
  const always = file('rules.md', 'Rule.', [
    binding({ profile: 'copilot-cli', tool: 'copilot', convention: 'copilot/repository-instructions', text: 'Rule.', scope: { kind: 'always' }, conflict: 'combined-no-precedence' }),
  ]);
  const artifact = buildArtifact(corpus([always, NESTED]), []);
  const copilot = artifact.sessions.find((s) => s.profile === 'copilot-cli');
  assert.ok(copilot);
  assert.deepEqual(copilot.cwds, ['.', 'pkg']);
});

test('projection: config exclude globs drop repo sources visibly', () => {
  const planted = file('tests/fixtures/instruction-corpus/x/repo/AGENTS.md', 'Never use npm.', [
    binding({ profile: 'codex-local', text: 'Never use npm.', scope: { kind: 'directory-subtree', directory: 'tests/fixtures/instruction-corpus/x/repo', via: 'cwd' } }),
  ]);
  const artifact = buildArtifact(corpus([ROOT, planted]), ['tests/fixtures/**']);
  assert.deepEqual(artifact.sources.map((s) => s.path), ['AGENTS.md']);
  assert.deepEqual(artifact.excluded, ['tests/fixtures/instruction-corpus/x/repo/AGENTS.md']);
  // The excluded file no longer appears in any session class.
  for (const session of artifact.sessions) {
    for (const entry of [...session.confirmed, ...session.conditional]) {
      assert.notEqual(entry.sourceId, planted.locator);
    }
  }
});

test('projection: conditional members carry reasons and stay out of confirmed', () => {
  const gated = file('.github/instructions/api.instructions.md', 'API rule.', [
    binding({
      profile: 'copilot-cli',
      tool: 'copilot',
      convention: 'copilot/path-instructions',
      text: 'API rule.',
      scope: { kind: 'glob', globs: ['src/api/**'] },
      activation: 'on-path-access',
      conflict: 'combined-no-precedence',
    }),
  ]);
  const artifact = buildArtifact(corpus([gated]), []);
  const session = artifact.sessions[0]!;
  assert.equal(session.confirmed.length, 0);
  assert.equal(session.conditional.length, 1);
  assert.match(session.conditional[0]!.reason, /no touched path matches/);
});

test('serialization is canonical and slice preserves artifact order', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED]), []);
  const { sources, sessions } = slice(artifact, ['repo:pkg/AGENTS.md', 'repo:AGENTS.md'], ['codex-local@pkg']);
  assert.deepEqual(sources.map((s) => s.id), ['repo:AGENTS.md', 'repo:pkg/AGENTS.md']);
  const a = serializePayload(sources, sessions, artifact.estimator);
  const b = serializePayload(sources, sessions, artifact.estimator);
  assert.equal(a, b);
  assert.ok(a.includes('"Use npm only."'));
  assert.ok(a.includes('"loadOrder"'));
});
