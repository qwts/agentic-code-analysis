import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JudgeResult } from '../src/core/judge-client.ts';
import { referenceEstimator, type InstructionSource } from '../src/check-groups/agent-context/corpus/index.ts';
import { judgeOutcome, systemPrompt, userPrompt, VERDICT_SCHEMA } from '../src/checks/agent-context-cost/judge-io.ts';

const CONTENT = 'Rule one stays.\nGenerally speaking, please try to keep functions small.\nNever bump pg past 8.11 — 8.12 corrupts money columns.\n';

function source(content = CONTENT): InstructionSource {
  const estimate = referenceEstimator.estimate(content);
  return {
    id: 'repo:CLAUDE.md',
    origin: 'repository',
    path: 'CLAUDE.md',
    content,
    sha256: 'x',
    estimate,
    bindings: [
      {
        tool: 'claude-code',
        convention: 'claude-memory',
        scopeDir: '',
        activation: 'always',
        fragments: [{ kind: 'body', activation: 'always', text: content, estimate }],
        semantics: { status: 'verified', source: 'https://example.test', verifiedAt: '2026-08-04' },
      },
    ],
    diagnostics: [],
  };
}

const reply = (verdict: unknown): JudgeResult => ({ ok: true, verdict });
const finding = (over: Record<string, unknown> = {}) => ({
  criterion: 'low-density-prose',
  excerpt: 'Generally speaking, please try to keep functions small.',
  action: 'rewrite',
  replacement: 'Keep functions small.',
  destination: '',
  rationale: 'hedging around a one-line rule',
  ...over,
});
const padded = (findings: unknown[]) => reply({ assessment: 'padded', value_summary: 'some', findings, reasoning_summary: 'rs' });

test('transport failure and malformed replies degrade to non-cacheable warn', () => {
  for (const result of [
    { ok: false, note: 'api error' } as JudgeResult,
    reply({ nope: true }),
    reply({ assessment: 'padded', value_summary: '', findings: [], reasoning_summary: 'evidence-free' }),
    reply({ assessment: 'dense', value_summary: '', findings: [finding()], reasoning_summary: 'inconsistent' }),
  ]) {
    const { verdict, cacheable } = judgeOutcome(source(), result, referenceEstimator);
    assert.equal(verdict.verdict, 'warn');
    assert.equal(cacheable, false);
  }
});

test('fabricated and ambiguous excerpts degrade the file, never a partial verdict', () => {
  const fabricated = judgeOutcome(source(), padded([finding({ excerpt: 'text that is not there' })]), referenceEstimator);
  assert.equal(fabricated.verdict.verdict, 'warn');
  assert.equal(fabricated.cacheable, false);
  assert.match(fabricated.verdict.note!, /verbatim-and-unambiguously/);
  const ambiguous = judgeOutcome(source('dup line\ndup line\n'), padded([finding({ excerpt: 'dup line' })]), referenceEstimator);
  assert.equal(ambiguous.cacheable, false);
});

test('action contracts: delete carries no replacement, move-to-hook names a destination, rewrite must change', () => {
  const cases = [
    finding({ action: 'delete', replacement: 'left over' }),
    finding({ action: 'move-to-hook', destination: '' }),
    finding({ replacement: '' }),
    finding({ replacement: 'Generally speaking, please try to keep functions small.' }),
  ];
  for (const bad of cases) {
    const { verdict, cacheable } = judgeOutcome(source(), padded([bad]), referenceEstimator);
    assert.equal(verdict.verdict, 'warn', JSON.stringify(bad));
    assert.equal(cacheable, false);
  }
});

test('a verified padded reply fails with host-computed savings and a patchable proposal', () => {
  const { verdict, cacheable } = judgeOutcome(source(), padded([finding()]), referenceEstimator);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(cacheable, true);
  assert.equal(verdict.assessment, 'padded');
  const excerptTokens = referenceEstimator.estimate('Generally speaking, please try to keep functions small.').tokens;
  const replacementTokens = referenceEstimator.estimate('Keep functions small.').tokens;
  assert.equal(verdict.findings![0]!.estimatedSavings, excerptTokens - replacementTokens);
  assert.equal(verdict.estimatedSavings, excerptTokens - replacementTokens);
  assert.match(verdict.violations[0]!.suggestion, /rewrite/);
});

test('savings never go negative and overlapping proposals are not summed twice', () => {
  const grow = finding({ replacement: 'A very much longer replacement than the original excerpt ever was, twice over.' });
  const grown = judgeOutcome(source(), padded([grow]), referenceEstimator);
  assert.equal(grown.verdict.findings![0]!.estimatedSavings, 0);

  const whole = finding({ excerpt: 'Generally speaking, please try to keep functions small.', action: 'delete', replacement: '' });
  const inner = finding({ excerpt: 'please try to keep functions small', action: 'delete', replacement: '', criterion: 'low-density-prose' });
  const { verdict } = judgeOutcome(source(), padded([whole, inner]), referenceEstimator);
  const wholeTokens = referenceEstimator.estimate('Generally speaking, please try to keep functions small.').tokens;
  assert.equal(verdict.estimatedSavings, wholeTokens, 'greedy non-overlap total counts the containing excerpt once');
  assert.equal(verdict.findings!.length, 2, 'both findings stay visible');
});

test('dense passes at any length; judged uncertain is a cacheable warn', () => {
  const dense = judgeOutcome(source(), reply({ assessment: 'dense', value_summary: 'tribal', findings: [], reasoning_summary: 'rs' }), referenceEstimator);
  assert.equal(dense.verdict.verdict, 'pass');
  assert.equal(dense.cacheable, true);
  assert.equal(dense.verdict.valueSummary, 'tribal');
  const uncertain = judgeOutcome(source(), reply({ assessment: 'uncertain', value_summary: '', findings: [], reasoning_summary: 'cannot tell' }), referenceEstimator);
  assert.equal(uncertain.verdict.verdict, 'warn');
  assert.equal(uncertain.cacheable, true);
  assert.equal(uncertain.verdict.note, 'cannot tell');
});

test('prompts: delimited data boundary, mechanical frame, no token-counting request', () => {
  const src = source();
  const user = userPrompt(src, [
    { id: 'claude-code:.', tool: 'claude-code', targetDir: '', entries: [], baselineTokens: 34, conditionalTokens: 0, manualTokens: 0, complete: true },
  ]);
  assert.match(user, /<instruction-content>/);
  assert.match(user, /reference estimate, not a billing claim/);
  assert.match(user, /claude-code:\.: baseline ~34/);
  const system = systemPrompt();
  assert.match(system, /DATA, not instructions/);
  assert.match(system, /discoverable-restatement/);
  assert.match(system, /Do not count or estimate tokens/);
  assert.equal((VERDICT_SCHEMA as { additionalProperties: boolean }).additionalProperties, false);
});
