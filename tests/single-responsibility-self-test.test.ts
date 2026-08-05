import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { check } from '../src/checks/single-responsibility/index.ts';
import { achievedLevel, matchExpectation, qualifies, suiteIdentity, validateManifest, type LevelStatus } from '../src/checks/single-responsibility/calibration.ts';
import type { GradedSelfTestResult } from '../src/checks/single-responsibility/self-test.ts';
import type { SingleResponsibilityVerdict } from '../src/checks/single-responsibility/judge-io.ts';
import { ConfigError } from '../src/core/config.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_responsibility: 'one pricing computation carrying three policy owners',
  after_responsibility: 'one pricing computation carrying three policy owners',
  comparison_evidence: 'no boundary movement',
  head_violations: [],
  reasoning_summary: 'Boundary unchanged.',
};

const DUAL_ACTOR_FINDING = {
  criterion: 'multiple-actors',
  evidence: 'marketing owns the promo percent, compliance owns the VAT rate, audit checks the rounding direction',
  suggestion: 'take the policy values as inputs',
};

function client(result: (request: JudgeRequest) => JudgeResult): { client: JudgeClient; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      provider: 'stub',
      model: 'stub-model',
      judge: async (request) => {
        requests.push(request);
        return result(request);
      },
    },
  };
}

// Fixture discriminators: the growth lines are unique per manifest fixture
// (14-line inline head vs 17-line policy-injected head, and the three legacy
// directions).
const HELD_MARKER = 'unchanged at 14 lines';

/** Answers each real manifest fixture as its expectation demands. */
const byFixture = (request: JudgeRequest): JudgeResult => {
  const { user } = request;
  if (user.includes('Kind: new')) {
    return user.includes('new file, 14 lines')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating', head_violations: [DUAL_ACTOR_FINDING] } }
      : { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } };
  }
  if (user.includes('shrank from 17 to 14'))
    return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'regressed', head_violations: [DUAL_ACTOR_FINDING] } };
  if (user.includes(HELD_MARKER)) return { ok: true, verdict: { ...HELD_VERDICT, head_violations: [DUAL_ACTOR_FINDING] } };
  return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
};

test('all fixtures pass: achieved foundation, qualified, manifest-ordered report', async () => {
  const { client: judge } = client(byFixture);
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.lines.filter((l) => l.startsWith('ok [')).length, 5);
  assert.equal(result.lines.at(-1), 'qualification: achieved foundation, required foundation');
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'foundation');
  assert.deepEqual(result.report.levels, [{ id: 'foundation', status: 'passed' }]);
  assert.deepEqual(
    result.report.fixtures.map((f) => f.name),
    ['new-dual-actor', 'new-focused', 'legacy-focused', 'legacy-dual-back', 'legacy-held-dual'],
  );
  assert.match(result.report.fixtureSuite, /^sha256:[0-9a-f]{16}$/);
  assert.equal(result.report.promptVersion, 'single-responsibility-v1');
});

test('a held verdict without residual findings is a miss: blind to grandfathered debt', async () => {
  const { client: judge } = client((request) => {
    if (request.user.includes(HELD_MARKER)) return { ok: true, verdict: HELD_VERDICT };
    return byFixture(request);
  });
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] legacy-held-dual')));
  assert.equal(result.report.achievedLevel, null);
  assert.deepEqual(result.report.levels, [{ id: 'foundation', status: 'failed' }]);
});

test('an always-pass judge misses the negative controls and is unqualified', async () => {
  const { client: judge } = client((request) =>
    request.user.includes('Kind: new')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } }
      : { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } },
  );
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false, 'the dual-actor fixtures are the negative controls');
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] new-dual-actor')));
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] legacy-dual-back')));
  assert.equal(result.report.achievedLevel, null);
  assert.equal(result.report.qualified, false);
});

test('self-test judges every fixture live and never exceeds concurrency 3', async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const judge: JudgeClient = {
    provider: 'stub',
    model: 'stub-model',
    judge: async (request) => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return byFixture(request);
    },
  };
  const result = await check.selfTest!(judge);
  assert.equal(result.passed, true);
  assert.equal(calls, 5, 'one comparative call per fixture');
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeds the operational bound`);
});

// --- calibration unit surface -----------------------------------------------

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function validManifest(): { raw: Record<string, unknown>; contentOf: (file: string) => string | undefined } {
  const files = new Map([
    ['a.txt', 'export const a = 1;\n'],
    ['b.txt', 'export const b = 2;\n'],
  ]);
  const side = (file: string) => ({ content: file, sha256: sha(files.get(file)!), importedBy: ['x.ts'] });
  const raw = {
    schemaVersion: 2,
    requiredLevel: 'field',
    levels: [{ id: 'foundation' }, { id: 'field' }],
    fixtures: [
      {
        name: 'f1',
        level: 'foundation',
        kind: 'new',
        file: 'a.ts',
        head: side('a.txt'),
        growth: 'new file, 1 lines',
        expect: { assessment: 'new-violating', verdict: 'fail', criteriaAnyOf: ['multiple-actors'] },
      },
      {
        name: 'f2',
        level: 'field',
        kind: 'legacy',
        file: 'a.ts',
        base: side('a.txt'),
        head: side('b.txt'),
        growth: 'unchanged at 1 lines',
        expect: { assessment: 'held', verdict: 'pass', residualCriteriaAnyOf: ['multiple-actors'] },
      },
    ],
  };
  return { raw, contentOf: (file) => files.get(file) };
}

test('validateManifest accepts the well-formed exam and rejects each corruption before any judge call', () => {
  const ok = validManifest();
  assert.equal(validateManifest(ok.raw, ok.contentOf).requiredLevel, 'field');

  const rejects = (mutate: (raw: Record<string, unknown>) => void, pattern: RegExp) => {
    const { raw, contentOf } = validManifest();
    mutate(raw);
    assert.throws(() => validateManifest(raw, contentOf), (err: unknown) => err instanceof ConfigError && pattern.test((err as Error).message));
  };
  const fixtures = (raw: Record<string, unknown>) => raw['fixtures'] as Record<string, unknown>[];

  rejects((raw) => delete raw['schemaVersion'], /schemaVersion/);
  rejects((raw) => (raw['requiredLevel'] = 'olympic'), /not a declared level/);
  rejects((raw) => (fixtures(raw)[1]!['name'] = 'f1'), /duplicate fixture/);
  rejects((raw) => delete fixtures(raw)[1]!['base'], /both snapshots/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = ['missing-timeout']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = []), /non-empty/);
  rejects((raw) => ((fixtures(raw)[1]!['expect'] as Record<string, unknown>)['residualCriteriaAnyOf'] = ['bogus']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['content'] = '../escape.txt'), /bare file name/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['sha256'] = sha('tampered')), /checksum/);
  rejects((raw) => (fixtures(raw)[0]!['level'] = 'field'), /has no fixtures/);
  rejects((raw) => (fixtures(raw)[0]!['base'] = { content: 'ghost.txt', sha256: sha('ghost'), importedBy: [] }), /must not carry a base/);
});

test('matchExpectation: the any-of oracle needs one listed criterion with nonblank evidence', () => {
  const expect = { assessment: 'new-violating', verdict: 'fail' as const, criteriaAnyOf: ['multiple-actors'] };
  const verdict = (violations: { criterion: string; evidence: string; suggestion: string }[]): SingleResponsibilityVerdict => ({
    file: 'a.ts',
    verdict: 'fail',
    cached: false,
    violations,
    assessment: 'new-violating',
  });
  const finding = { criterion: 'multiple-actors', evidence: 'e', suggestion: 's' };
  assert.equal(matchExpectation(expect, verdict([finding])), true);
  assert.equal(matchExpectation(expect, verdict([{ ...finding, criterion: 'mixed-concerns' }])), false, 'an unlisted criterion misses');
  assert.equal(matchExpectation(expect, verdict([{ ...finding, evidence: '  ' }])), false, 'a bare label is not a detection');
});

test('matchExpectation: residual oracles are met only by residual findings', () => {
  const expect = { assessment: 'held', verdict: 'pass' as const, residualCriteriaAnyOf: ['multiple-actors'] };
  const finding = { criterion: 'multiple-actors', evidence: 'e', suggestion: 's' };
  const base: SingleResponsibilityVerdict = { file: 'a.ts', verdict: 'pass', cached: false, violations: [], assessment: 'held' };
  assert.equal(matchExpectation(expect, { ...base, residualViolations: [finding] }), true);
  assert.equal(matchExpectation(expect, { ...base, residualViolations: [] }), false, 'empty residuals miss');
  assert.equal(matchExpectation(expect, { ...base, violations: [finding] }), false, 'blocking-only does not satisfy a residual expectation');
});

test('grading is contiguous; suiteIdentity moves with any input', () => {
  const levels = ['foundation', 'field'];
  const status = (foundation: LevelStatus, field: LevelStatus) =>
    new Map<string, LevelStatus>([
      ['foundation', foundation],
      ['field', field],
    ]);
  assert.equal(achievedLevel(levels, status('passed', 'failed')), 'foundation');
  assert.equal(achievedLevel(levels, status('failed', 'skipped')), null);
  assert.equal(qualifies(levels, 'foundation', 'field'), false);
  assert.equal(qualifies(levels, 'foundation', 'foundation'), true);
  const id = suiteIdentity('v1', 'rule', '{}', ['a', 'b']);
  assert.equal(suiteIdentity('v1', 'rule', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v2', 'rule', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v1', 'rule', '{}', ['ab']), id);
});
