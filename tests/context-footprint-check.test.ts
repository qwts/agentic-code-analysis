import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/context-footprint/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const PASS_VERDICT = {
  verdict: 'pass',
  practical_test_answer: 'this file alone',
  violations: [],
  reasoning_summary: 'Coherent.',
};

function countingClient(result: () => JudgeResult): { client: JudgeClient; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      provider: 'stub',
      model: 'stub-model',
      judge: async (request) => {
        requests.push(request);
        return result();
      },
    },
  };
}

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-check-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b;\n`);
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  return root;
}

function context(root: string, client: JudgeClient) {
  return {
    repoRoot: root,
    baseRef: 'main',
    files: ['a.ts', 'b.ts'],
    client,
    cache: new VerdictCache(join(root, '.cache', 'aca'), check.name),
  };
}

test('second run on unchanged files makes zero judge calls, verdicts marked cached', async () => {
  const root = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: PASS_VERDICT }));
  const first = await check.run(context(root, client));
  assert.equal(requests.length, 2);
  assert.deepEqual(first.map((v) => v.cached), [false, false]);

  const second = await check.run(context(root, client));
  assert.equal(requests.length, 2, 'cache hit must not call the judge');
  assert.deepEqual(second.map((v) => v.cached), [true, true]);
  assert.deepEqual(second.map((v) => v.verdict), ['pass', 'pass']);
});

test('degraded results are not cached: the next run retries the judge', async () => {
  const root = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const first = await check.run(context(root, client));
  assert.deepEqual(first.map((v) => v.verdict), ['warn', 'warn']);
  assert.equal(requests.length, 2);
  await check.run(context(root, client));
  assert.equal(requests.length, 4, 'degraded verdicts must retry, not stick');
});

test('judge payload carries the real import graph of the repo', async () => {
  const root = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: PASS_VERDICT }));
  await check.run(context(root, client));
  const forA = requests.find((r) => r.user.includes('File: a.ts'))!;
  const forB = requests.find((r) => r.user.includes('File: b.ts'))!;
  assert.ok(forA.user.includes('b.ts'), 'a.ts imports b.ts');
  assert.match(forB.user, /Imported by \(paths only\):\na\.ts/);
});

test('self-test passes when fixtures judge as expected, fails on a miss', async () => {
  const byFixture = (request: JudgeRequest): JudgeResult => {
    const enumerated = request.user.includes('| BlobGetRequest');
    return enumerated
      ? { ok: true, verdict: { ...PASS_VERDICT, verdict: 'fail', violations: [{ criterion: 'relocation-not-design', evidence: 'e', suggestion: 's' }] } }
      : { ok: true, verdict: PASS_VERDICT };
  };
  const good = await check.selfTest!({ provider: 'stub', model: 'm', judge: async (r) => byFixture(r) });
  assert.equal(good.passed, true);
  assert.equal(good.lines.filter((l) => l.startsWith('ok ')).length, 2);

  const alwaysPass = await check.selfTest!({ provider: 'stub', model: 'm', judge: async () => ({ ok: true, verdict: PASS_VERDICT }) });
  assert.equal(alwaysPass.passed, false, 'enumerated fixture passing is the negative control');
  assert.ok(alwaysPass.lines.some((l) => l.startsWith('MISS enumerated-messages')));
});
