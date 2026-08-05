import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comparison, Snapshot } from '../src/checks/failure-posture/comparison.ts';
import { judgeOutcome, rubricText, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/failure-posture/judge-io.ts';
import type { PrefilterHint } from '../src/checks/failure-posture/prefilter.ts';

const HEAD: Snapshot = { path: 'src/x.ts', content: 'const head = 1;', imports: ['src/a.ts'], importedBy: ['src/b.ts', 'src/c.ts'] };
const BASE: Snapshot = { path: 'src/x-old.ts', content: 'const base = 1;', imports: ['src/a.ts', 'src/z.ts'], importedBy: ['src/b.ts'] };
const LEGACY: Comparison = { kind: 'legacy', base: BASE, head: HEAD, growth: 'shrank from 10 to 5 lines' };
const NEW: Comparison = { kind: 'new', head: HEAD, growth: 'new file, 5 lines' };
const HINT: PrefilterHint = { kind: 'network', source: 'call', token: 'fetch' };
const NO_HINTS = { head: [] };

test('system prompt embeds the authoritative rubric verbatim, never a paraphrase', () => {
  const rubric = rubricText();
  assert.ok(rubric.includes('slow') && rubric.includes('lying'));
  assert.ok(systemPrompt(rubric).includes(rubric));
});

test('system prompt carries the security boundary and the scenario requirement', () => {
  const prompt = systemPrompt(rubricText());
  assert.match(prompt, /never report them here/);
  assert.match(prompt, /hints, not proof/);
  assert.match(prompt, /concrete misbehavior scenario/);
});

test('legacy prompt carries both snapshots, graphs, growth, rename, and per-side hints', () => {
  const prompt = userPrompt(LEGACY, { head: [HINT], base: [{ kind: 'storage', source: 'import', token: 'pg' }] });
  for (const expected of [
    'Kind: legacy',
    'Renamed from: src/x-old.ts',
    'shrank from 10 to 5 lines',
    'network/call: fetch',
    'storage/import: pg',
    'const base = 1;',
    'const head = 1;',
    'src/z.ts',
    'src/c.ts',
    '<base-content>',
    '<head-content>',
  ]) {
    assert.ok(prompt.includes(expected), `missing: ${expected}`);
  }
});

test('new prompt has no base section; empty hints render as (none)', () => {
  const prompt = userPrompt(NEW, NO_HINTS);
  assert.ok(prompt.includes('Kind: new'));
  assert.match(prompt, /routing hints, not proof\):\n\(none\)/);
  assert.ok(!prompt.includes('<base-content>'));
  assert.ok(!prompt.includes('Renamed from'));
});

test('verdict schema is strict: additionalProperties false, all fields required, closed criteria', () => {
  assert.equal(VERDICT_SCHEMA['additionalProperties'], false);
  assert.deepEqual(VERDICT_SCHEMA['required'], [
    'assessment',
    'before_failure_posture',
    'after_failure_posture',
    'comparison_evidence',
    'head_violations',
    'reasoning_summary',
  ]);
  const items = (VERDICT_SCHEMA['properties'] as Record<string, Record<string, Record<string, unknown>>>)['head_violations']!['items']!;
  assert.equal(items['additionalProperties'], false);
  const criterion = (items['properties'] as Record<string, Record<string, unknown>>)['criterion']!;
  assert.ok((criterion['enum'] as string[]).includes('missing-timeout'));
  assert.ok(!(criterion['enum'] as string[]).includes('fail-open'), 'security labels stay out of the closed set');
});

const VIOLATION = {
  criterion: 'missing-timeout',
  evidence: 'if the coordinator hangs, this await blocks the worker forever — no deadline, no signal',
  suggestion: 'pass an AbortSignal.timeout per attempt',
};
const JUDGED = {
  assessment: 'regressed',
  before_failure_posture: 'bounded retries with deadlines',
  after_failure_posture: 'hot infinite loop with no deadline',
  comparison_evidence: 'the head removed the attempt cap and the timeout',
  head_violations: [VIOLATION],
  reasoning_summary: 'The change removes every resilience bound.',
};

test('regressed maps to a cacheable fail carrying the evidence and the base path', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: JUDGED });
  assert.equal(cacheable, true);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.assessment, 'regressed');
  assert.equal(verdict.basePath, 'src/x-old.ts');
  assert.equal(verdict.violations[0]!.criterion, 'missing-timeout');
  assert.deepEqual(verdict.residualViolations, []);
  assert.equal(verdict.note, 'The change removes every resilience bound.');
});

test('improved and held pass, retaining head violations as residual debt', () => {
  for (const assessment of ['improved', 'held']) {
    const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment } });
    assert.equal(cacheable, true);
    assert.equal(verdict.verdict, 'pass');
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.residualViolations!.length, 1);
    assert.equal(verdict.note, `posture ${assessment}; residual debt`);
  }
});

test('new-compliant passes clean; new-violating fails on evidence', () => {
  const compliant = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant', head_violations: [] } });
  assert.deepEqual([compliant.verdict.verdict, compliant.cacheable], ['pass', true]);
  const violating = judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating' } });
  assert.deepEqual([violating.verdict.verdict, violating.cacheable], ['fail', true]);
});

test('a judged uncertain is a cacheable warn — it describes the pair, not the transport', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'uncertain', head_violations: [] } });
  assert.equal(cacheable, true);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'The change removes every resilience bound.']);
});

test('blocking assessments with blank scenario evidence degrade: the scenario is the finding', () => {
  for (const evidence of ['', '   ']) {
    const { verdict, cacheable } = judgeOutcome(NEW, {
      ok: true,
      verdict: { ...JUDGED, assessment: 'new-violating', head_violations: [{ ...VIOLATION, evidence }] },
    });
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.equal(verdict.note, 'judge failed without scenario evidence');
  }
});

test('transport degradation maps to warn with the note, not cacheable', () => {
  const { verdict, cacheable } = judgeOutcome(LEGACY, { ok: false, note: 'judge refused (cyber)' });
  assert.equal(cacheable, false);
  assert.deepEqual([verdict.verdict, verdict.note], ['warn', 'judge refused (cyber)']);
});

test('malformed, kind-incompatible, and out-of-set-criterion replies degrade to a non-cacheable warn', () => {
  const cases = [
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating' } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'improved' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, assessment: 'vibes' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [] } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-violating', head_violations: [] } }),
    judgeOutcome(NEW, { ok: true, verdict: { ...JUDGED, assessment: 'new-compliant' } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [null] } }),
    // A security-flavored label is outside the closed reliability set: malformed.
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [{ ...VIOLATION, criterion: 'fail-open' }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, head_violations: [{ criterion: 'missing-timeout', evidence: 5, suggestion: null }] } }),
    judgeOutcome(LEGACY, { ok: true, verdict: { ...JUDGED, reasoning_summary: 7 } }),
  ];
  for (const { verdict, cacheable } of cases) {
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
    assert.ok(verdict.note);
  }
});
