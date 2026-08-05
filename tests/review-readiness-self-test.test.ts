import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfTest } from '../src/checks/review-readiness/self-test.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const DEBUG_FINDING = {
  criterion: 'leftover-debug',
  file: 'src/report.ts',
  line: 8,
  evidence: "console.log('DBG sorted', sorted) is a forgotten debug print",
  suggestion: 'delete the print',
};
const SILENCED_FINDING = {
  criterion: 'silenced-test',
  file: 'tests/report.test.ts',
  line: 9,
  evidence: 'test newly skipped with { skip: true } and no stated reason',
  suggestion: 'unskip the test or state why it is skipped',
};

function scriptedClient(respond: (request: JudgeRequest) => JudgeResult): { client: JudgeClient; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      provider: 'stub',
      model: 'stub-model',
      judge: async (request) => {
        requests.push(request);
        return respond(request);
      },
    },
  };
}

const isDebrisCase = (request: JudgeRequest): boolean => request.user.includes('DBG sorted');

test('a judge that discriminates both fixtures qualifies; one live call per fixture', async () => {
  const { client, requests } = scriptedClient((request) =>
    isDebrisCase(request)
      ? { ok: true, verdict: { assessment: 'not-ready', findings: [DEBUG_FINDING, SILENCED_FINDING], reasoning_summary: 'debris' } }
      : { ok: true, verdict: { assessment: 'ready', findings: [], reasoning_summary: 'clean' } },
  );
  const result = await selfTest(client);
  assert.equal(requests.length, 2, 'exactly one call per pair fixture');
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'discriminates');
  assert.match(result.report.fixtureSuite, /^sha256:/);
  assert.deepEqual(
    result.report.fixtures.map((f) => f.status),
    ['ok', 'ok'],
  );
});

test('detecting only one of the two planted smells is a miss — the pair oracle is all-of', async () => {
  const { client } = scriptedClient((request) =>
    isDebrisCase(request)
      ? { ok: true, verdict: { assessment: 'not-ready', findings: [DEBUG_FINDING], reasoning_summary: 'partial' } }
      : { ok: true, verdict: { assessment: 'ready', findings: [], reasoning_summary: 'clean' } },
  );
  const result = await selfTest(client);
  assert.equal(result.passed, false);
  assert.equal(result.report.achievedLevel, null);
  assert.equal(result.report.fixtures.find((f) => f.name === 'debris-multi-file')!.status, 'miss');
});

test('flagging the clean equivalent is a miss — intentional items are not findings', async () => {
  const { client } = scriptedClient((request) =>
    isDebrisCase(request)
      ? { ok: true, verdict: { assessment: 'not-ready', findings: [DEBUG_FINDING, SILENCED_FINDING], reasoning_summary: 'debris' } }
      : { ok: true, verdict: { assessment: 'uncertain', findings: [], reasoning_summary: 'cannot tell' } },
  );
  const result = await selfTest(client);
  assert.equal(result.passed, false);
  assert.equal(result.report.fixtures.find((f) => f.name === 'clean-equivalent')!.status, 'miss');
});
