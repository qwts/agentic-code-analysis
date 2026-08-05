import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { check } from '../src/checks/failure-posture/index.ts';
import { achievedLevel, matchExpectation, qualifies, suiteIdentity, validateManifest, type LevelStatus } from '../src/checks/failure-posture/calibration.ts';
import type { GradedSelfTestResult } from '../src/checks/failure-posture/self-test.ts';
import type { FailurePostureVerdict } from '../src/checks/failure-posture/judge-io.ts';
import { ConfigError } from '../src/core/config.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_failure_posture: 'surfaces failures to the caller',
  after_failure_posture: 'surfaces failures to the caller',
  comparison_evidence: 'no posture movement',
  head_violations: [],
  reasoning_summary: 'Sound at both ends.',
};

const UNSAFE_FINDINGS = [
  { criterion: 'missing-timeout', evidence: 'if the coordinator hangs, the await blocks forever', suggestion: 'per-attempt deadline' },
  { criterion: 'retry-without-backoff', evidence: 'if it is down, the loop hammers it hot', suggestion: 'capped jittered backoff' },
  { criterion: 'unbounded-retry', evidence: 'while (true) never gives up', suggestion: 'bound the attempts' },
];

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

// Fixture discriminators: the unsafe head retains `while (true)`; the growth
// lines separate the two legacy directions from the held pair.
const FIELD_MARKER = 'unchanged at 25 lines';

/** Answers each real manifest fixture as its expectation demands. */
const byFixture = (request: JudgeRequest): JudgeResult => {
  const { user } = request;
  if (user.includes('Kind: new')) {
    return user.includes('while (true)')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating', head_violations: UNSAFE_FINDINGS } }
      : { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } };
  }
  if (user.includes('shrank from 43 to 25'))
    return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'regressed', head_violations: UNSAFE_FINDINGS } };
  if (user.includes(FIELD_MARKER)) return { ok: true, verdict: { ...HELD_VERDICT, head_violations: UNSAFE_FINDINGS } };
  return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
};

test('all levels pass: achieved field, qualified, manifest-ordered report', async () => {
  const { client: judge } = client(byFixture);
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.lines.filter((l) => l.startsWith('ok [')).length, 5);
  assert.equal(result.lines.at(-1), 'qualification: achieved field, required field');
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'field');
  assert.deepEqual(result.report.levels, [
    { id: 'foundation', status: 'passed' },
    { id: 'field', status: 'passed' },
  ]);
  assert.deepEqual(
    result.report.fixtures.map((f) => f.name),
    ['new-unsafe', 'new-resilient', 'legacy-hardened', 'legacy-softened', 'legacy-held-debt'],
  );
  assert.match(result.report.fixtureSuite, /^sha256:[0-9a-f]{16}$/);
  assert.equal(result.report.promptVersion, 'failure-posture-v2');
});

test('naming only one of the required criteria misses the all-of oracle', async () => {
  const { client: judge } = client((request) => {
    if (request.user.includes('Kind: new') && request.user.includes('while (true)'))
      return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating', head_violations: [UNSAFE_FINDINGS[0]!] } };
    return byFixture(request);
  });
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] new-unsafe')));
});

test('a held verdict without residual findings is a field miss: blind to known debt', async () => {
  const { client: judge } = client((request) => {
    if (request.user.includes(FIELD_MARKER)) return { ok: true, verdict: HELD_VERDICT };
    return byFixture(request);
  });
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((l) => l.startsWith('MISS [field] legacy-held-debt')));
  assert.equal(result.report.achievedLevel, 'foundation');
  assert.deepEqual(result.report.levels[1], { id: 'field', status: 'failed' });
});

test('an always-pass judge misses foundation and field is never billed', async () => {
  const { client: judge, requests } = client((request) =>
    request.user.includes('Kind: new')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } }
      : { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } },
  );
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false, 'the unsafe fixtures are the negative control');
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] new-unsafe')));
  assert.ok(result.lines.some((l) => l.startsWith('skip [field] legacy-held-debt')));
  assert.equal(requests.filter((r) => r.user.includes(FIELD_MARKER)).length, 0, 'a failed level must stop spend on higher levels');
  assert.equal(result.report.achievedLevel, null);
});

test('self-test requests carry prefilter hints and never exceed concurrency 3', async () => {
  let inFlight = 0;
  let peak = 0;
  const requests: JudgeRequest[] = [];
  const judge: JudgeClient = {
    provider: 'stub',
    model: 'stub-model',
    judge: async (request) => {
      requests.push(request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return byFixture(request);
    },
  };
  const result = await check.selfTest!(judge);
  assert.equal(result.passed, true);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeds the operational bound`);
  assert.ok(requests.every((r) => r.user.includes('network/call: fetch')), 'every fixture is a network candidate');
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
        expect: { assessment: 'new-violating', verdict: 'fail', criteriaAllOf: ['missing-timeout', 'retry-without-backoff'] },
      },
      {
        name: 'f2',
        level: 'field',
        kind: 'legacy',
        file: 'a.ts',
        base: side('a.txt'),
        head: side('b.txt'),
        growth: 'unchanged at 1 lines',
        expect: { assessment: 'held', verdict: 'pass', residualCriteriaAllOf: ['missing-timeout'] },
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
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAllOf'] = ['fail-open']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAllOf'] = []), /non-empty/);
  rejects((raw) => ((fixtures(raw)[1]!['expect'] as Record<string, unknown>)['residualCriteriaAllOf'] = ['bogus']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['content'] = '../escape.txt'), /bare file name/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['sha256'] = sha('tampered')), /checksum/);
  rejects((raw) => (fixtures(raw)[0]!['level'] = 'field'), /has no fixtures/);
  rejects((raw) => (fixtures(raw)[0]!['base'] = { content: 'ghost.txt', sha256: sha('ghost'), importedBy: [] }), /must not carry a base/);
});

test('matchExpectation: the all-of oracle requires every listed criterion with nonblank evidence', () => {
  const expect = { assessment: 'new-violating', verdict: 'fail' as const, criteriaAllOf: ['missing-timeout', 'retry-without-backoff'] };
  const verdict = (violations: { criterion: string; evidence: string; suggestion: string }[]): FailurePostureVerdict => ({
    file: 'a.ts',
    verdict: 'fail',
    cached: false,
    violations,
    assessment: 'new-violating',
  });
  const timeout = { criterion: 'missing-timeout', evidence: 'e', suggestion: 's' };
  const backoff = { criterion: 'retry-without-backoff', evidence: 'e', suggestion: 's' };
  assert.equal(matchExpectation(expect, verdict([timeout, backoff])), true);
  assert.equal(matchExpectation(expect, verdict([timeout])), false, 'one of two required criteria misses');
  assert.equal(matchExpectation(expect, verdict([timeout, { ...backoff, evidence: '  ' }])), false, 'a bare label is not a detection');
});

test('matchExpectation: residual oracles are met only by residual findings', () => {
  const expect = { assessment: 'held', verdict: 'pass' as const, residualCriteriaAllOf: ['missing-timeout'] };
  const finding = { criterion: 'missing-timeout', evidence: 'e', suggestion: 's' };
  const base: FailurePostureVerdict = { file: 'a.ts', verdict: 'pass', cached: false, violations: [], assessment: 'held' };
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
  const id = suiteIdentity('v1', 'rubric', '{}', ['a', 'b']);
  assert.equal(suiteIdentity('v1', 'rubric', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v2', 'rubric', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v1', 'rubric', '{}', ['ab']), id);
});
