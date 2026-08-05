import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { check } from '../src/checks/test-honesty/index.ts';
import { achievedLevel, matchExpectation, qualifies, suiteIdentity, validateManifest, type LevelStatus } from '../src/checks/test-honesty/calibration.ts';
import type { GradedSelfTestResult } from '../src/checks/test-honesty/self-test.ts';
import type { TestHonestyVerdict } from '../src/checks/test-honesty/judge-io.ts';
import { ConfigError } from '../src/core/config.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HONEST_VERDICT = { assessment: 'honest', findings: [], reasoning_summary: 'discriminating assertions' };

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
  const finding = (test: string, criterion: string) => ({
    ok: true as const,
    verdict: { assessment: 'dishonest', findings: [{ test, criterion, evidence: 'quoted oracle', meaningful_assertion: 'what a real assertion would establish' }], reasoning_summary: 'cannot fail' },
  });
  const { user } = request;
  if (user.includes('invoice-service')) return finding('fetchInvoiceTotal returns the gateway total', 'asserts-own-mock');
  if (user.includes('config-io')) return finding('serializeConfig produces the expected wire form', 'tautology');
  if (user.includes('parseManifest')) return finding('parseManifest extracts the dependency list', 'no-meaningful-assertion');
  if (user.includes('renderDashboard')) return finding('renderDashboard matches snapshot', 'unreviewable-snapshot');
  return { ok: true, verdict: HONEST_VERDICT };
};

test('all fixtures pass: achieved foundation, qualified, manifest-ordered report', async () => {
  const { client: judge } = client(byFixture);
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.lines.filter((line) => line.startsWith('ok [')).length, 8);
  assert.equal(result.lines.at(-1), 'qualification: achieved foundation, required foundation');
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'foundation');
  assert.deepEqual(result.report.levels, [{ id: 'foundation', status: 'passed' }]);
  assert.equal(result.report.fixtures.length, 8);
  assert.match(result.report.fixtureSuite, /^sha256:[0-9a-f]{16}$/);
  assert.equal(result.report.promptVersion, 'test-honesty-v1');
});

test('an always-honest judge misses the negative controls and is unqualified', async () => {
  const { client: judge } = client(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false, 'a judge that always passes is the negative control');
  assert.ok(result.lines.some((line) => line.startsWith('MISS [foundation] asserts-own-mock')));
  assert.ok(result.lines.some((line) => line.startsWith('MISS [foundation] tautology')));
  assert.equal(result.report.achievedLevel, null);
  assert.deepEqual(result.report.levels, [{ id: 'foundation', status: 'failed' }]);
});

test('a fail without meaningful-assertion text is a miss: a bare label is not a detection', async () => {
  const { client: judge } = client((request) => {
    const result = byFixture(request);
    if (result.ok && request.user.includes('invoice-service')) {
      const verdict = result.verdict as { findings: { meaningful_assertion: string }[] };
      verdict.findings[0]!.meaningful_assertion = '';
    }
    return result;
  });
  const result = (await check.selfTest!(judge)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.ok(result.lines.some((line) => line.startsWith('MISS [foundation] asserts-own-mock')));
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
  assert.equal(calls, 8, 'one judgment per fixture');
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeds the operational bound`);
});

// --- calibration unit surface -----------------------------------------------

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function validManifest(): { raw: Record<string, unknown>; contentOf: (file: string) => string | undefined } {
  const files = new Map([
    ['a.txt', "test('a', () => {});\n"],
    ['b.txt', "test('b', () => {});\n"],
  ]);
  const raw = {
    schemaVersion: 2,
    requiredLevel: 'field',
    levels: [{ id: 'foundation' }, { id: 'field' }],
    fixtures: [
      {
        name: 'f1',
        level: 'foundation',
        file: 'tests/a.test.ts',
        content: 'a.txt',
        sha256: sha(files.get('a.txt')!),
        units: [{ path: 'src/a.ts', exports: ['export function a(): void {'] }],
        snapshots: [],
        unavailable: [],
        expect: { assessment: 'dishonest', verdict: 'fail', criteriaAnyOf: ['tautology'], testNameIncludes: 'a' },
      },
      {
        name: 'f2',
        level: 'field',
        file: 'tests/b.test.ts',
        content: 'b.txt',
        sha256: sha(files.get('b.txt')!),
        units: [],
        snapshots: [],
        unavailable: ['unit exports unavailable'],
        expect: { assessment: 'honest', verdict: 'pass' },
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
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = ['multiple-actors']), /unknown criterion/);
  rejects((raw) => ((fixtures(raw)[0]!['expect'] as Record<string, unknown>)['criteriaAnyOf'] = []), /non-empty/);
  rejects((raw) => (fixtures(raw)[0]!['content'] = '../escape.txt'), /bare file name/);
  rejects((raw) => (fixtures(raw)[0]!['sha256'] = sha('tampered')), /checksum/);
  rejects((raw) => (fixtures(raw)[0]!['content'] = 'ghost.txt'), /64 lowercase hex|is missing|checksum/);
  rejects((raw) => (fixtures(raw)[0]!['units'] = [{ path: 'src/a.ts' }]), /unit needs/);
  rejects((raw) => (fixtures(raw)[0]!['unavailable'] = 'nope'), /string array/);
  rejects((raw) => (fixtures(raw)[0]!['level'] = 'field'), /has no fixtures/);
});

test('matchExpectation: criteria matches must carry the pinned test name and assertion text', () => {
  const expect = { assessment: 'dishonest', verdict: 'fail' as const, criteriaAnyOf: ['tautology'], testNameIncludes: 'serializeConfig' };
  const verdict = (findings: { test: string; criterion: 'asserts-own-mock' | 'tautology' | 'no-meaningful-assertion' | 'unreviewable-snapshot'; evidence: string; meaningful_assertion: string }[]): TestHonestyVerdict => ({
    file: 'tests/config-io.test.ts',
    verdict: 'fail',
    cached: false,
    violations: [],
    assessment: 'dishonest',
    findings,
  });
  const finding = { test: 'serializeConfig produces the expected wire form', criterion: 'tautology' as const, evidence: 'e', meaningful_assertion: 'm' };
  assert.equal(matchExpectation(expect, verdict([finding])), true);
  assert.equal(matchExpectation(expect, verdict([{ ...finding, criterion: 'asserts-own-mock' }])), false, 'an unlisted criterion misses');
  assert.equal(matchExpectation(expect, verdict([{ ...finding, test: 'other test' }])), false, 'the pinned test name must match');
  assert.equal(matchExpectation(expect, verdict([{ ...finding, meaningful_assertion: '  ' }])), false, 'a fail must state the missing assertion');
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
  const id = suiteIdentity('v1', 'rubric', '{}', ['a', 'b']);
  assert.equal(suiteIdentity('v1', 'rubric', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v2', 'rubric', '{}', ['a', 'b']), id);
  assert.notEqual(suiteIdentity('v1', 'rubric', '{}', ['ab']), id);
});
