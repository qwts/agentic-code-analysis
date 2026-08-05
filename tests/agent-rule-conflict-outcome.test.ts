import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JudgeResult } from '../src/core/judge-client.ts';
import { buildArtifact } from '../src/checks/agent-rule-conflict/artifact.ts';
import type { Partition } from '../src/checks/agent-rule-conflict/partition.ts';
import {
  attributeFindings,
  CORPUS_ROW,
  toVerdicts,
  validatePartition,
  type PartitionOutcome,
  type PartitionResult,
  type ValidatedConflict,
} from '../src/checks/agent-rule-conflict/outcome.ts';
import { binding, conflictsFound, corpus, file, reply } from './agent-rule-conflict-helpers.ts';

const A = 'Always use npm for installs.';
const B = 'Never use npm; pnpm is the only supported tool.';
const SOURCES = new Map([
  ['repo:AGENTS.md', { path: 'AGENTS.md', content: `# Rules\n\n${A}\n` }],
  ['repo:CLAUDE.md', { path: 'CLAUDE.md', content: `# Memory\n\n${B}\n` }],
]);

const conflict = (over: Record<string, unknown> = {}) => ({
  criterion: 'direct-contradiction',
  rule_a: { source_id: 'repo:AGENTS.md', quote: A },
  rule_b: { source_id: 'repo:CLAUDE.md', quote: B },
  explanation: 'both cannot be followed',
  resolution: 'consolidate',
  suggestion: 'pick one package manager',
  ...over,
});

test('transport, malformed, and envelope-incompatible replies degrade', () => {
  const cases: JudgeResult[] = [
    { ok: false, note: 'api error' },
    reply({ nope: true }),
    reply({ assessment: 'conflicts-found', conflicts: [], reasoning_summary: 'evidence-free' }),
    reply({ assessment: 'no-conflict', conflicts: [conflict()], reasoning_summary: 'inconsistent' }),
    reply({ assessment: 'uncertain', conflicts: [conflict()], reasoning_summary: 'inconsistent' }),
  ];
  for (const result of cases) {
    const out = validatePartition(result, SOURCES);
    assert.equal(out.ok, false);
  }
});

test('invented ids, fabricated/ambiguous quotes, same-span pairs, and blank evidence degrade', () => {
  const ambiguous = new Map([['repo:AGENTS.md', { path: 'AGENTS.md', content: `${A}\n${A}\n` }]]);
  for (const [sources, bad] of [
    [SOURCES, conflict({ rule_a: { source_id: 'repo:GHOST.md', quote: A } })],
    [SOURCES, conflict({ rule_b: { source_id: 'repo:CLAUDE.md', quote: 'not present anywhere' } })],
    [SOURCES, conflict({ rule_b: { source_id: 'repo:CLAUDE.md', quote: '' } })],
    [ambiguous, conflict({ rule_a: { source_id: 'repo:AGENTS.md', quote: A }, rule_b: { source_id: 'repo:AGENTS.md', quote: A } })],
    [SOURCES, conflict({ explanation: '  ' })],
    [SOURCES, conflict({ suggestion: '' })],
  ] as const) {
    const out = validatePartition(conflictsFound([bad]), sources);
    assert.equal(out.ok, false, JSON.stringify(bad));
  }
  // Same source, same span: not two rules.
  const same = validatePartition(
    conflictsFound([conflict({ rule_a: { source_id: 'repo:AGENTS.md', quote: A }, rule_b: { source_id: 'repo:AGENTS.md', quote: A } })]),
    SOURCES,
  );
  assert.equal(same.ok, false);
});

test('a valid conflict is canonically ordered with derived line ranges', () => {
  const swapped = conflictsFound([conflict({ rule_a: { source_id: 'repo:CLAUDE.md', quote: B }, rule_b: { source_id: 'repo:AGENTS.md', quote: A } })]);
  const out = validatePartition(swapped, SOURCES);
  assert.ok(out.ok);
  const found = out.outcome.conflicts[0]!;
  assert.equal(found.ruleA.sourceId, 'repo:AGENTS.md');
  assert.equal(found.ruleA.startLine, 3);
  assert.equal(found.ruleA.endLine, 3);
  assert.equal(found.ruleB.sourceId, 'repo:CLAUDE.md');
});

test('uncertain is a valid outcome with zero conflicts', () => {
  const out = validatePartition(reply({ assessment: 'uncertain', conflicts: [], reasoning_summary: 'cannot tell' }), SOURCES);
  assert.ok(out.ok);
  assert.equal(out.outcome.assessment, 'uncertain');
});

// ---- severity attribution over the corpus map ----

function artifactWith(policy: 'closer-overrides' | 'unresolved', profiles: ('codex-local' | 'claude-local')[] = ['codex-local', 'codex-local']) {
  const agents = file('AGENTS.md', `# Rules\n\n${A}\n`, [
    binding({ profile: profiles[0]!, text: A, conflict: policy }),
  ]);
  const claude = file('CLAUDE.md', `# Memory\n\n${B}\n`, [
    binding({
      profile: profiles[1]!,
      tool: 'claude-code',
      convention: 'claude-code/memory',
      text: B,
      conflict: policy,
      order: { kind: 'ordered', rule: 'memory', rank: 5 },
    }),
  ]);
  return buildArtifact(corpus([agents, claude]), []);
}

const validated = (over: Partial<ValidatedConflict> = {}): ValidatedConflict => ({
  criterion: 'direct-contradiction',
  ruleA: { sourceId: 'repo:AGENTS.md', file: 'AGENTS.md', startLine: 3, endLine: 3, offset: 9, quote: A },
  ruleB: { sourceId: 'repo:CLAUDE.md', file: 'CLAUDE.md', startLine: 3, endLine: 3, offset: 10, quote: B },
  explanation: 'both cannot be followed',
  resolution: 'consolidate',
  suggestion: 'pick one package manager',
  ...over,
});

const partition = (id: string, over: Partial<Partition> = {}): Partition => ({
  id,
  kind: 'whole-corpus',
  sessionIds: [],
  sourceIds: ['repo:AGENTS.md', 'repo:CLAUDE.md'],
  estimatedTokens: 10,
  bytes: 100,
  fits: true,
  ...over,
});

const judged = (id: string, conflicts: ValidatedConflict[], assessment: PartitionOutcome['assessment'] = conflicts.length > 0 ? 'conflicts-found' : 'no-conflict'): PartitionResult => ({
  partition: partition(id),
  status: 'judged',
  outcome: { assessment, note: 'rs', conflicts },
});

test('verified confirmed co-load with known policies blocks', () => {
  // Same profile loads both sources -> a confirmed co-loading session.
  const artifact = artifactWith('closer-overrides');
  const findings = attributeFindings([judged('whole-corpus', [validated()])], artifact);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.verdict, 'fail');
  assert.deepEqual(findings[0]!.sessionsLoadingBoth, ['codex-local@.']);
  assert.equal(findings[0]!.semanticsUnverified, false);
});

test('co-load under unresolved conflict policy warns as unverified semantics', () => {
  const artifact = artifactWith('unresolved');
  const findings = attributeFindings([judged('whole-corpus', [validated()])], artifact);
  assert.equal(findings[0]!.verdict, 'warn');
  assert.equal(findings[0]!.semanticsUnverified, true);
  assert.match(findings[0]!.note!, /unresolved conflict-policy/);
});

test('no session loading both rules warns with explicitly empty attribution', () => {
  const artifact = artifactWith('closer-overrides', ['codex-local', 'claude-local']);
  const findings = attributeFindings([judged('whole-corpus', [validated()])], artifact);
  assert.equal(findings[0]!.verdict, 'warn');
  assert.deepEqual(findings[0]!.sessionsLoadingBoth, []);
  assert.match(findings[0]!.note!, /no session loads both/);
});

test('duplicate findings dedupe across partitions; criterion disagreement downgrades', () => {
  const artifact = artifactWith('closer-overrides');
  const agree = attributeFindings([judged('p1', [validated()]), judged('p2', [validated()])], artifact);
  assert.equal(agree.length, 1);
  assert.deepEqual(agree[0]!.partitionIds, ['p1', 'p2']);
  assert.equal(agree[0]!.verdict, 'fail');

  const disagree = attributeFindings(
    [judged('p1', [validated()]), judged('p2', [validated({ criterion: 'unresolved-precedence' })])],
    artifact,
  );
  assert.equal(disagree.length, 1);
  assert.equal(disagree[0]!.verdict, 'warn');
  assert.match(disagree[0]!.note!, /partitions disagree/);
});

test('verdict rows group by first rule file; corpus row carries partitions and health', () => {
  const artifact = artifactWith('closer-overrides');
  const results: PartitionResult[] = [judged('whole-corpus', [validated()])];
  const rows = toVerdicts(results, artifact);
  assert.deepEqual(rows.map((r) => r.file), ['AGENTS.md', CORPUS_ROW]);
  const [finding, corpusRow] = rows;
  assert.equal(finding!.verdict, 'fail');
  assert.equal(finding!.violations.length, 1);
  assert.match(finding!.violations[0]!.evidence, /sessions: codex-local@\./);
  assert.equal(corpusRow!.verdict, 'pass');
  assert.equal(corpusRow!.assessment, 'conflicts-found');
  assert.equal(corpusRow!.partitions!.length, 1);
  assert.equal(corpusRow!.partitions![0]!.status, 'judged');
});

test('degraded, skipped-oversize, and uncertain partitions surface on the corpus row', () => {
  const artifact = artifactWith('closer-overrides');
  const rows = toVerdicts(
    [
      { partition: partition('p1'), status: 'degraded', note: 'judge refused' },
      { partition: partition('p2', { sessionIds: ['codex-local@.'] }), status: 'skipped-oversize', note: 'over bound' },
      { partition: partition('p3'), status: 'judged', outcome: { assessment: 'uncertain', note: 'unclear', conflicts: [] } },
    ],
    artifact,
  );
  const corpusRow = rows.at(-1)!;
  assert.equal(corpusRow.verdict, 'warn');
  assert.match(corpusRow.note!, /degraded/);
  assert.match(corpusRow.note!, /uncovered: p2 \(codex-local@\./);
  assert.match(corpusRow.note!, /uncertain/);
  assert.equal(corpusRow.assessment, 'uncertain');
});

test('cached flags: finding rows and corpus row report cache provenance', () => {
  const artifact = artifactWith('closer-overrides');
  const rows = toVerdicts([{ partition: partition('whole-corpus'), status: 'cached', outcome: { assessment: 'conflicts-found', note: 'rs', conflicts: [validated()] } }], artifact);
  assert.equal(rows[0]!.cached, true);
  assert.equal(rows.at(-1)!.cached, true);
});
