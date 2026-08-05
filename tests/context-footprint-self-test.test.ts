import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { check } from '../src/checks/context-footprint/index.ts';
import { achievedLevel, matchExpectation, qualifies, suiteIdentity, validateManifest, type LevelStatus } from '../src/checks/context-footprint/calibration.ts';
import type { GradedSelfTestResult } from '../src/checks/context-footprint/self-test.ts';
import type { ContextFootprintVerdict } from '../src/checks/context-footprint/judge-io.ts';
import { ConfigError } from '../src/core/config.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_practical_test: 'this file alone',
  after_practical_test: 'this file alone',
  comparison_evidence: 'no structural movement',
  head_violations: [],
  reasoning_summary: 'Coherent at both ends.',
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

/** Answers each real manifest fixture as its expectation demands. */
const byFixture = (request: JudgeRequest): JudgeResult => {
  const { user } = request;
  if (user.includes('Kind: new')) {
    return user.includes('| BlobGetRequest')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating', head_violations: [{ criterion: 'relocation-not-design', evidence: 'e', suggestion: 's' }] } }
      : { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } };
  }
  if (user.includes('grew from 51 to 245'))
    return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'regressed', head_violations: [{ criterion: 'duplicated-context', evidence: 'e', suggestion: 's' }] } };
  if (user.includes('shrank from 550 to 356'))
    return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved', head_violations: [{ criterion: 'mixed-responsibility', evidence: 'e', suggestion: 's' }] } };
  return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
};

const FIELD_MARKER = 'shrank from 550 to 356';

test('all levels pass: achieved field, qualified, manifest-ordered report', async () => {
  const { client: judge } = client(byFixture);
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.lines.filter((l) => l.startsWith('ok [')).length, 5);
  assert.equal(result.lines.at(-1), 'qualification: achieved field, required field');
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'field');
  assert.equal(result.report.requiredLevel, 'field');
  assert.deepEqual(
    result.report.levels,
    [
      { id: 'foundation', status: 'passed' },
      { id: 'field', status: 'passed' },
    ],
  );
  assert.deepEqual(
    result.report.fixtures.map((f) => f.name),
    ['new-enumerated', 'new-composed', 'legacy-composed', 'legacy-enumerated-back', 'legacy-improved-residual'],
  );
  assert.match(result.report.fixtureSuite, /^sha256:[0-9a-f]{16}$/);
  assert.equal(result.report.promptVersion, 'context-footprint-v2');
});

test('a clean improved on the field fixture is a miss: achieved foundation, not qualified', async () => {
  const { client: judge } = client((request) => {
    if (request.user.includes(FIELD_MARKER)) return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
    return byFixture(request);
  });
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((l) => l.startsWith('MISS [field] legacy-improved-residual')));
  assert.equal(result.lines.at(-1), 'qualification: achieved foundation, required field');
  assert.equal(result.report.achievedLevel, 'foundation');
  assert.equal(result.report.qualified, false);
  assert.deepEqual(result.report.levels[1], { id: 'field', status: 'failed' });
});

test('a residual with blank evidence does not satisfy the field oracle', async () => {
  const { client: judge } = client((request) => {
    if (request.user.includes(FIELD_MARKER))
      return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved', head_violations: [{ criterion: 'mixed-responsibility', evidence: '   ', suggestion: 's' }] } };
    return byFixture(request);
  });
  const result = await check.selfTest!(judge);
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((l) => l.startsWith('MISS [field]')));
});

test('a foundation miss skips field entirely: no judge call, no qualification', async () => {
  const { client: judge, requests } = client(() => ({ ok: true, verdict: HELD_VERDICT }));
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false, 'the regression fixtures are the negative control');
  assert.ok(result.lines.some((l) => l.startsWith('MISS [foundation] new-enumerated')));
  assert.ok(result.lines.some((l) => l.startsWith('skip [field] legacy-improved-residual')));
  assert.equal(result.lines.at(-1), 'qualification: achieved none, required field');
  assert.equal(requests.filter((r) => r.user.includes(FIELD_MARKER)).length, 0, 'a failed level must stop spend on higher levels');
  assert.equal(result.report.achievedLevel, null);
  assert.deepEqual(result.report.levels[1], { id: 'field', status: 'skipped' });
  assert.equal(result.report.fixtures[4]!.status, 'skipped');
  assert.equal(result.report.fixtures[4]!.actual, undefined);
});

test('self-test requests never exceed concurrency 3', async () => {
  let inFlight = 0;
  let peak = 0;
  const judge: JudgeClient = {
    provider: 'stub',
    model: 'stub-model',
    judge: async (request) => {
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
      { name: 'f1', level: 'foundation', kind: 'new', file: 'a.ts', head: side('a.txt'), growth: 'new file, 1 lines', expect: { assessment: 'new-compliant', verdict: 'pass' } },
      {
        name: 'f2',
        level: 'field',
        kind: 'legacy',
        file: 'a.ts',
        base: side('a.txt'),
        head: side('b.txt'),
        growth: 'unchanged at 1 lines',
        expect: { assessment: 'improved', verdict: 'pass', residualCriteriaAnyOf: ['duplicated-context'] },
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
  assert.throws(() => validateManifest([], () => undefined), /v1 array/);
  rejects((raw) => (raw['requiredLevel'] = 'olympic'), /not a declared level/);
  rejects((raw) => (raw['levels'] = [{ id: 'foundation' }, { id: 'foundation' }]), /duplicate level/);
  rejects((raw) => (fixtures(raw)[1]!['name'] = 'f1'), /duplicate fixture/);
  rejects((raw) => (fixtures(raw)[0]!['level'] = 'unknown'), /unknown level/);
  rejects((raw) => delete fixtures(raw)[1]!['base'], /both snapshots/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['assessment'] = 'stellar'), /unknown assessment/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = ['bogus-criterion']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = []), /non-empty/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['content'] = '../escape.txt'), /bare file name/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['content'] = 'missing.txt'), /is missing/);
  rejects((raw) => ((fixtures(raw)[0]!['head'] as Record<string, unknown>)['sha256'] = sha('tampered')), /checksum/);
  rejects((raw) => (fixtures(raw)[0]!['level'] = 'field'), /has no fixtures/);
});

test('matchExpectation: residual oracle requires a residual finding, not a blocking one', () => {
  const expect = { assessment: 'improved', verdict: 'pass' as const, residualCriteriaAnyOf: ['duplicated-context'] };
  const verdict = (extra: Partial<ContextFootprintVerdict>): ContextFootprintVerdict => ({
    file: 'a.ts',
    verdict: 'pass',
    cached: false,
    violations: [],
    assessment: 'improved',
    ...extra,
  });
  const finding = { criterion: 'duplicated-context', evidence: 'e', suggestion: 's' };
  assert.equal(matchExpectation(expect, verdict({ residualViolations: [finding] })), true);
  assert.equal(matchExpectation(expect, verdict({ residualViolations: [] })), false, 'empty residuals miss');
  assert.equal(matchExpectation(expect, verdict({ residualViolations: [{ ...finding, criterion: 'over-fragmentation' }] })), false, 'unrelated criterion misses');
  assert.equal(matchExpectation(expect, verdict({ violations: [finding], verdict: 'pass' })), false, 'blocking-only does not satisfy a residual expectation');
});

test('grading is contiguous and ordered', () => {
  const levels = ['foundation', 'field'];
  const status = (foundation: LevelStatus, field: LevelStatus) =>
    new Map<string, LevelStatus>([
      ['foundation', foundation],
      ['field', field],
    ]);
  assert.equal(achievedLevel(levels, status('passed', 'passed')), 'field');
  assert.equal(achievedLevel(levels, status('passed', 'failed')), 'foundation');
  assert.equal(achievedLevel(levels, status('failed', 'skipped')), null);
  assert.equal(qualifies(levels, 'field', 'field'), true);
  assert.equal(qualifies(levels, 'foundation', 'field'), false);
  assert.equal(qualifies(levels, null, 'foundation'), false);
});

test('suiteIdentity is deterministic and moves with any input', () => {
  const id = suiteIdentity('v2', 'rule', '{}', ['a', 'b']);
  assert.equal(suiteIdentity('v2', 'rule', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v3', 'rule', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v2', 'rule', '{}', ['a', 'c']), id);
  // Concatenation boundaries cannot collide: ["ab"] vs ["a","b"].
  assert.notEqual(suiteIdentity('v2', 'rule', '{}', ['ab']), suiteIdentity('v2', 'rule', '{}', ['a', 'b']));
});
