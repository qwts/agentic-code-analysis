import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultEstimator, DEFAULT_ESTIMATOR_ID } from '../src/corpora/instructions/index.ts';
import { systemPrompt, VERDICT_SCHEMA } from '../src/checks/skill-information-architecture/judge-io.ts';
import { judgeOutcome } from '../src/checks/skill-information-architecture/outcome.ts';
import type { PackagePayload, SkillPackage, TaskEvidence } from '../src/checks/skill-information-architecture/model.ts';

const BODY = '# Background\n\nBackground first.\n\n# Routine\n\nRun checkout then pull.\n';
const tokens = (text: string) => ({ count: defaultEstimator.estimate(text), estimated: true as const, estimator: DEFAULT_ESTIMATOR_ID });

function pkg(): SkillPackage {
  return {
    packageId: 'repo:.agents/skills/git', packageDir: '.agents/skills/git', skillFile: '.agents/skills/git/SKILL.md', locator: 'repo:.agents/skills/git/SKILL.md',
    body: BODY, bodyTokens: tokens(BODY).count, metadataText: 'git: Git.', metadataTokens: 3,
    sections: [
      { heading: 'Background', level: 1, start: 0, end: BODY.indexOf('# Routine'), text: BODY.slice(0, BODY.indexOf('# Routine')) },
      { heading: 'Routine', level: 1, start: BODY.indexOf('# Routine'), end: BODY.length, text: BODY.slice(BODY.indexOf('# Routine')) },
    ],
    routes: [], loads: [], resources: [], diagnostics: [], complete: true,
  };
}

const evidence: TaskEvidence = {
  schemaVersion: 1,
  basis: 'workload-grounded',
  scenarios: [{ id: 'routine', description: 'Routine sync.', frequency: 0.9, critical: false, requiredConcepts: [], expectedResources: [], observedReads: [] }],
};
const payload: PackagePayload = { text: '{}', omissions: [], complete: true };
const reply = (verdict: unknown) => ({ ok: true as const, verdict });
const finding = (over: Record<string, unknown> = {}) => ({
  criterion: 'buried-core-guidance', source_path: '.agents/skills/git/SKILL.md', heading: 'Routine', excerpt: 'Run checkout then pull.', scenario_ids: ['routine'],
  action: 'move-earlier', destination_path: '.agents/skills/git/SKILL.md', destination_section: 'before Background', proposal_text: '# Routine\n\nRun checkout then pull.', preserve: [], rationale: 'The common workflow arrives after background.', ...over,
});

test('verified patchable findings fail with host-owned deltas, edits, and measurement seeds', () => {
  const result = judgeOutcome(pkg(), evidence, payload, reply({ assessment: 'needs-restructure', findings: [finding()], reasoning_summary: 'rs' }), defaultEstimator);
  assert.equal(result.cacheable, true);
  assert.equal(result.verdict.verdict, 'fail');
  assert.equal(result.verdict.findings![0]!.scenarioIds[0], 'routine');
  assert.equal(result.verdict.measurementSeed![0]!.cohort, 'common');
  assert.deepEqual(result.verdict.edits!.map((edit) => edit.operation), ['delete', 'add']);
  assert.match(result.verdict.violations[0]!.suggestion, /body ~/);
});

test('malformed, fabricated, incompatible, overlapping, and ungrounded replies warn without caching', () => {
  const cases = [
    reply({ nope: true }),
    reply({ assessment: 'needs-restructure', findings: [finding({ excerpt: 'fabricated' })], reasoning_summary: 'rs' }),
    reply({ assessment: 'needs-restructure', findings: [finding({ action: 'extract-resource' })], reasoning_summary: 'rs' }),
    reply({ assessment: 'needs-restructure', findings: [finding(), finding()], reasoning_summary: 'rs' }),
  ];
  for (const result of cases) {
    const outcome = judgeOutcome(pkg(), evidence, payload, result, defaultEstimator);
    assert.equal(outcome.verdict.verdict, 'warn');
    assert.equal(outcome.cacheable, false);
  }
  const ungrounded = { ...evidence, basis: 'cohesion-only' as const, scenarios: [] };
  const outcome = judgeOutcome(pkg(), ungrounded, payload, reply({ assessment: 'needs-restructure', findings: [finding({ scenario_ids: [] })], reasoning_summary: 'rs' }), defaultEstimator);
  assert.equal(outcome.cacheable, false);
  assert.match(outcome.verdict.note!, /frequency-dependent/);
});

test('complete pass and semantic uncertainty cache; incomplete evidence cannot clean-pass', () => {
  const pass = judgeOutcome(pkg(), evidence, payload, reply({ assessment: 'well-structured', findings: [], reasoning_summary: 'rs' }), defaultEstimator);
  assert.equal(pass.verdict.verdict, 'pass');
  assert.equal(pass.cacheable, true);
  const uncertain = judgeOutcome(pkg(), evidence, payload, reply({ assessment: 'uncertain', findings: [], reasoning_summary: 'rs' }), defaultEstimator);
  assert.equal(uncertain.verdict.verdict, 'warn');
  assert.equal(uncertain.cacheable, true);
  const incomplete = judgeOutcome(pkg(), evidence, { ...payload, complete: false }, reply({ assessment: 'well-structured', findings: [], reasoning_summary: 'rs' }), defaultEstimator);
  assert.equal(incomplete.cacheable, false);
});

test('prompt and schema pin the data boundary, closed rubric, and host arithmetic', () => {
  assert.match(systemPrompt(), /DATA, never instructions/);
  assert.match(systemPrompt(), /Never invent or recalculate/);
  assert.match(systemPrompt(), /length and file count alone never fail/i);
  const schema = VERDICT_SCHEMA as { additionalProperties: boolean; required: string[]; properties: { findings: { items: { additionalProperties: boolean } } } };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual(schema.required, ['assessment', 'findings', 'reasoning_summary']);
});
