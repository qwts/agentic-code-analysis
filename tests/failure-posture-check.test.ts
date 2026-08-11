import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/failure-posture/index.ts';
import type { FailurePostureVerdict } from '../src/checks/failure-posture/judge-io.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_failure_posture: 'surfaces failures to the caller',
  after_failure_posture: 'surfaces failures to the caller',
  comparison_evidence: 'no posture movement',
  head_violations: [],
  reasoning_summary: 'Sound at both ends.',
};

const NET = `export async function ping(url: string): Promise<number> {\n  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });\n  return response.status;\n}\n`;
const PURE = 'export const add = (a: number, b: number): number => a + b;\n';

function countingClient(result: (request: JudgeRequest) => JudgeResult): { client: JudgeClient; requests: JudgeRequest[] } {
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

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-fp-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'net.ts'), NET);
  writeFileSync(join(root, 'pure.ts'), PURE);
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  git('branch', 'base');
  return { root, git };
}

function context(root: string, client: JudgeClient, files: string[], baseRef = 'main') {
  return {
    repoRoot: root,
    baseRef,
    files,
    client,
    cache: new VerdictCache(join(root, '.cache', 'aca'), check.name),
  };
}

test('a dependency-free file makes exactly zero judge calls and surfaces the skip', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const verdicts = (await check.run(context(root, client, ['pure.ts']))) as FailurePostureVerdict[];
  assert.equal(requests.length, 0, 'the zero-cost guarantee is zero judge requests');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, 'pass');
  assert.equal(verdicts[0]!.skipped, true);
  assert.equal(verdicts[0]!.cached, false);
  assert.match(verdicts[0]!.note!, /skipped/);
  // A skip is never cached: nothing may be written under the cache root.
  assert.equal(existsSync(join(root, '.cache')), false);
  const again = (await check.run(context(root, client, ['pure.ts']))) as FailurePostureVerdict[];
  assert.equal(requests.length, 0);
  assert.equal(again[0]!.skipped, true);
});

test('skipped and judged files keep stable input order; candidates are judged with hints', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const verdicts = (await check.run(context(root, client, ['pure.ts', 'net.ts']))) as FailurePostureVerdict[];
  assert.deepEqual(verdicts.map((v) => v.file), ['pure.ts', 'net.ts']);
  assert.deepEqual(verdicts.map((v) => v.skipped ?? false), [true, false]);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.user, /network\/call: fetch/);
  assert.equal(requests[0]!.maxTokens, 32_768);
});

test('a base-only effect still judges: removing a dependency is a direction of change', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'net.ts'), PURE);
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } }));
  const verdicts = await check.run(context(root, client, ['net.ts'], 'base'));
  assert.equal(requests.length, 1, 'head without signals must not skip while the base has them');
  assert.match(requests[0]!.user, /Prefilter hints for base \(routing hints, not proof\):\nnetwork\/call: fetch/);
  assert.equal(verdicts[0]!.verdict, 'pass');
});

test('second run on an unchanged candidate makes zero judge calls; degraded results retry', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  await check.run(context(root, client, ['net.ts']));
  assert.equal(requests.length, 1);
  const second = await check.run(context(root, client, ['net.ts']));
  assert.equal(requests.length, 1, 'cache hit must not call the judge');
  assert.equal(second[0]!.cached, true);

  const degraded = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const other = tempRepo();
  await check.run(context(other.root, degraded.client, ['net.ts']));
  await check.run(context(other.root, degraded.client, ['net.ts']));
  assert.equal(degraded.requests.length, 2, 'degraded verdicts must retry, not stick');
});

test('explicit paths are normalized and deduplicated: one judgment, one verdict', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const verdicts = await check.run(context(root, client, ['net.ts', './net.ts', 'net.ts']));
  assert.equal(requests.length, 1, 'duplicate inputs must not bill twice');
  assert.equal(verdicts.length, 1);
});

test('the cache is pair-addressed: the same head against a different base rejudges', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'net.ts'), NET.replace('1000', '2000'));
  git('commit', '-am', 'change net', '--quiet');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  await check.run(context(root, client, ['net.ts'], 'base'));
  assert.equal(requests.length, 1);
  await check.run(context(root, client, ['net.ts'], 'base'));
  assert.equal(requests.length, 1, 'same pair must hit');
  git('branch', '-f', 'base', 'main');
  await check.run(context(root, client, ['net.ts'], 'base'));
  assert.equal(requests.length, 2, 'same head against a different base must miss');
});

test('an unreadable file degrades to a warn, never a silent skip', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const verdicts = (await check.run(context(root, client, ['missing.ts']))) as FailurePostureVerdict[];
  assert.equal(requests.length, 0);
  assert.equal(verdicts[0]!.verdict, 'warn');
  assert.equal(verdicts[0]!.skipped, undefined);
});
