import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comparison, Snapshot } from '../src/checks/naming-truth/comparison.ts';
import { judgeOutcome, ruleText, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/naming-truth/judge-io.ts';

const HEAD: Snapshot = { path: 'src/x.ts', content: 'const head = 1;', imports: ['src/a.ts'], importedBy: ['src/b.ts', 'src/c.ts'] };
const BASE: Snapshot = { path: 'src/x-old.ts', content: 'const base = 1;', imports: ['src/a.ts', 'src/z.ts'], importedBy: ['src/b.ts'] };
const LEGACY: Comparison = { kind: 'legacy', base: BASE, head: HEAD };
const NEW: Comparison = { kind: 'new', head: HEAD };

const FINDING = {
  criterion: 'name-omits-side-effect',
  symbol: 'getUser',
  symbol_kind: 'function',
  name_claim: 'a pure read of one user',
  actual_behavior: 'also writes the last-seen timestamp',
  evidence: 'db.updateLastSeen(id, clock.nowMs())',
  suggested_name: 'recordAccessAndGetUser',
  change: 'introduced',
};
const RESIDUAL_FINDING = { ...FINDING, symbol: 'countSessions', change: 'unchanged' };
const JUDGED = {
  assessment: 'regressed',
  before_behavior: 'pure read',
  after_behavior: 'read plus hidden write',
  comparison_evidence: 'the head adds db.updateLastSeen inside getUser',
  head_findings: [FINDING, RESIDUAL_FINDING],
  reasoning_summary: 'The change hid a write behind a query name.',
};

test('system prompt embeds the rule text verbatim and the untrusted-evidence boundary', () => {
  const rule = ruleText();
  assert.ok(rule.includes('An exported name is a contract'));
  const system = systemPrompt(rule);
  assert.ok(system.includes(rule));
  assert.ok(system.includes('UNTRUSTED EVIDENCE'), 'file contents must be declared data, not instructions');
});

test('legacy prompt carries both snapshots, their graphs, and the rename; no growth line', () => {
  const prompt = userPrompt(LEGACY);
  for (const expected of [
    'Kind: legacy',
    'Renamed from: src/x-old.ts',
    'const base = 1;',
    'const head = 1;',
    'src/z.ts',
    'src/c.ts',
    '<base-content>',
    '<head-content>',
  ]) {
    assert.ok(prompt.includes(expected), `missing: ${expected}`);
  }
  assert.ok(!prompt.includes('lines'), 'line counts are footprint orientation, not naming evidence');
});

test('new prompt has no base section and no rename line', () => {
  const prompt = userPrompt(NEW);
  assert.ok(prompt.includes('Kind: new'));
  assert.ok(prompt.includes('const head = 1;'));
  assert.ok(!prompt.includes('<base-content>'));
  assert.ok(!prompt.includes('Renamed from'));
});

test('verdict schema is strict: additionalProperties false, all fields required', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], [
    'assessment',
    'before_behavior',
    'after_behavior',
    'comparison_evidence',
    'head_findings',
    'reasoning_summary',
  ]);
  const findings = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, Record<string, unknown>>>)['head_findings']!['items']!;
  assert.equal(findings['additionalProperties'], false);
  assert.deepEqual(findings['required'], ['criterion', 'symbol', 'symbol_kind', 'name_claim', 'actual_behavior', 'evidence', 'suggested_name', 'change']);
});

test('regressed fails on introduced/worsened findings and retains unchanged ones as residuals', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: JUDGED });
  assert.equal(cacheable, true);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.assessment, 'regressed');
  assert.equal(verdict.basePath, 'src/x-old.ts');
  assert.deepEqual(verdict.violations.map((v) => v.symbol), ['getUser']);
  assert.deepEqual(verdict.residualViolations!.map((v) => v.symbol), ['countSessions']);
  assert.equal(verdict.note, 'The change hid a write behind a query name.');
});

test('derived strings carry the symbol, the claim vs behavior, and the advisory name', () => {
  const { verdict } = judgeOutcome(LEGACY, { ok: true, verdict: JUDGED });
  const v = verdict.violations[0]!;
  assert.equal(v.criterion, 'name-omits-side-effect');
  assert.ok(v.evidence.includes('getUser') && v.evidence.includes('a pure read of one user') && v.evidence.includes('db.updateLastSeen'));
  assert.ok(v.suggestion.includes('recordAccessAndGetUser'));
  assert.deepEqual([v.symbolKind, v.nameClaim, v.change], ['function', 'a pure read of one user', 'introduced']);
});

test('improved and held pass, retaining findings as residual debt', () => {
  for (const assessment of ['improved', 'held']) {
    const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment, head_findings: [RESIDUAL_FINDING] } });
    assert.equal(cacheable, true);
    assert.equal(verdict.verdict, 'pass');
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.residualViolations!.length, 1);
    assert.equal(verdict.note, `naming ${assessment}; residual debt`);
  }
});

test('improved with no remaining findings is a clean pass without a note', () => {
  const { verdict } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'improved', head_findings: [] } });
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.note, undefined);
  assert.deepEqual(verdict.residualViolations, []);
});

test('basePath is omitted when base and head paths match', () => {
  const samePath: Comparison = { kind: 'legacy', base: { ...BASE, path: 'src/x.ts' }, head: HEAD };
  const { verdict } = judgeOutcome(samePath, { ok: true, verdict: { ...JUDGED, assessment: 'held', head_findings: [] } });
  assert.equal(verdict.basePath, undefined);
});

test('new-compliant passes clean; new-violating fails on introduced evidence', () => {
  const compliant = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant', head_findings: [] } });
  assert.deepEqual([compliant.verdict.verdict, compliant.cacheable], ['pass', true]);
  const violating = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating', head_findings: [FINDING] } });
  assert.deepEqual([violating.verdict.verdict, violating.cacheable], ['fail', true]);
  assert.deepEqual(violating.verdict.residualViolations, []);
});

test('a judged uncertain is a cacheable warn — it describes the pair, not the transport', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'uncertain', head_findings: [] } });
  assert.equal(cacheable, true);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'The change hid a write behind a query name.']);
});

test('transport degradation maps to warn with the note, not cacheable', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: false, note: 'judge refused (cyber)' });
  assert.equal(cacheable, false);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'judge refused (cyber)']);
});

test('malformed, kind-incompatible, and change-inconsistent replies degrade to a non-cacheable warn', () => {
  const cases = [
    // assessment incompatible with the known kind
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating' } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'improved' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'vibes' } }),
    // blocking assessment without an introduced/worsened finding
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [RESIDUAL_FINDING] } }),
    // pass while naming findings
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant', head_findings: [FINDING] } }),
    // a new file cannot carry pre-existing findings
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating', head_findings: [FINDING, RESIDUAL_FINDING] } }),
    // improved/held cannot carry introduced or worsened findings
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'improved', head_findings: [FINDING] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'held', head_findings: [{ ...FINDING, change: 'worsened' }] } }),
    // blank required field
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [{ ...FINDING, evidence: '  ' }] } }),
    // shape failures
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [null] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [{ ...FINDING, criterion: 'ugly-name' }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [{ ...FINDING, symbol_kind: 'gizmo' }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_findings: [{ ...FINDING, change: 'sideways' }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, reasoning_summary: 7 } }),
  ];
  for (const { verdict, cacheable } of cases) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.ok(verdict.note);
  }
});
