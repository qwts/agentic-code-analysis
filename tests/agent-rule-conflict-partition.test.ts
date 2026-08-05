import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArtifact } from '../src/checks/agent-rule-conflict/artifact.ts';
import { BYTE_BUDGET, planPartitions, TOKEN_BUDGET, type Measure } from '../src/checks/agent-rule-conflict/partition.ts';
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
const CURSOR = file('.cursor/rules/style.mdc', 'Tabs only.', [
  binding({
    profile: 'cursor-editor-agent',
    tool: 'cursor',
    convention: 'cursor/project-rule-always',
    text: 'Tabs only.',
    scope: { kind: 'always' },
    order: { kind: 'unordered', rule: 'combined' },
    conflict: 'combined-no-precedence',
  }),
]);

const small: Measure = () => ({ tokens: 10, bytes: 100 });
const large: Measure = (sourceIds) => (sourceIds.length > 1 ? { tokens: TOKEN_BUDGET + 1, bytes: 100 } : { tokens: 10, bytes: 100 });

test('a fitting corpus is exactly one whole-corpus partition', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED, CURSOR]), []);
  const partitions = planPartitions(artifact, small);
  assert.equal(partitions.length, 1);
  assert.equal(partitions[0]!.kind, 'whole-corpus');
  assert.equal(partitions[0]!.fits, true);
  assert.deepEqual(partitions[0]!.sourceIds, artifact.sources.map((s) => s.id));
});

test('byte bound alone forces partitioning', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED]), []);
  const overBytes: Measure = (sourceIds) => ({ tokens: 10, bytes: sourceIds.length > 1 ? BYTE_BUDGET + 1 : 10 });
  const partitions = planPartitions(artifact, overBytes);
  assert.ok(partitions.length > 1);
  assert.ok(partitions.every((p) => p.kind !== 'whole-corpus'));
});

test('over budget: one unit per unique load set plus cross-tool comparison units', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED, CURSOR]), []);
  const partitions = planPartitions(artifact, large);
  const kinds = partitions.map((p) => p.kind);
  assert.ok(kinds.includes('session-load-set'));
  assert.ok(kinds.includes('cross-tool-comparison'));
  // Deterministic: same plan twice.
  assert.deepEqual(partitions.map((p) => p.id), planPartitions(artifact, large).map((p) => p.id));
  // Cross-tool units pair different-tool load sets with overlapping scopes
  // and carry both sides' complete source sets.
  const cross = partitions.filter((p) => p.kind === 'cross-tool-comparison');
  for (const unit of cross) {
    assert.ok(unit.sourceIds.length >= 2);
    assert.ok(unit.sessionIds.length >= 2);
  }
  // Codex sessions at '.' and at 'pkg' have different load sets — two units.
  const sessionUnits = partitions.filter((p) => p.kind === 'session-load-set');
  assert.ok(sessionUnits.length >= 3);
});

test('identical load sets coalesce into one unit', () => {
  const shared = file('AGENTS.md', 'Rule.', [
    binding({ profile: 'codex-local', text: 'Rule.' }),
    binding({ profile: 'copilot-cli', tool: 'copilot', convention: 'copilot/agent-instructions', text: 'Rule.', order: { kind: 'unordered', rule: 'combined' }, conflict: 'combined-no-precedence' }),
  ]);
  const artifact = buildArtifact(corpus([shared]), []);
  const over: Measure = () => ({ tokens: TOKEN_BUDGET + 1, bytes: 1 });
  const partitions = planPartitions(artifact, over);
  // Both profiles resolve to the identical single-source load set — but they
  // sit in different session classes; the load-set signature merges them.
  const units = partitions.filter((p) => p.kind === 'session-load-set');
  assert.equal(units.length, 1);
  assert.deepEqual(units[0]!.sessionIds, ['codex-local@.', 'copilot-cli@.']);
});

test('an indivisible oversize unit is marked, never silently dropped', () => {
  const artifact = buildArtifact(corpus([ROOT, NESTED]), []);
  const always: Measure = () => ({ tokens: TOKEN_BUDGET + 1, bytes: 1 });
  const partitions = planPartitions(artifact, always);
  assert.ok(partitions.length > 0);
  assert.ok(partitions.every((p) => p.fits === false));
});
