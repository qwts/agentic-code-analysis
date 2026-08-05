import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/single-responsibility/index.ts';
import { checks } from '../src/checks/registry.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_responsibility: 'one owner',
  after_responsibility: 'one owner',
  comparison_evidence: 'no boundary movement',
  head_violations: [],
  reasoning_summary: 'One actor at both ends.',
};

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
  const root = mkdtempSync(join(tmpdir(), 'aca-srp-check-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b;\n`);
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  git('branch', 'base');
  return { root, git };
}

function context(root: string, client: JudgeClient, files = ['a.ts', 'b.ts'], baseRef = 'main') {
  return {
    repoRoot: root,
    baseRef,
    files,
    client,
    cache: new VerdictCache(join(root, '.cache', 'aca'), check.name),
  };
}

test('the built-in registry exposes the check under its own name and tier', async () => {
  const loaded = await checks.get('single-responsibility')!();
  assert.equal(loaded.name, 'single-responsibility');
  assert.equal(loaded.tier, 'T1');
  assert.ok(loaded.selfTest, 'calibration self-test must be registered');
});

test('second run on unchanged files makes zero judge calls, verdicts marked cached', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const first = await check.run(context(root, client));
  assert.equal(requests.length, 2);
  assert.deepEqual(first.map((v) => v.cached), [false, false]);

  const second = await check.run(context(root, client));
  assert.equal(requests.length, 2, 'cache hit must not call the judge');
  assert.deepEqual(second.map((v) => v.cached), [true, true]);
  assert.deepEqual(second.map((v) => v.verdict), ['pass', 'pass']);
});

test('degraded results are not cached: the next run retries the judge', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const first = await check.run(context(root, client));
  assert.deepEqual(first.map((v) => v.verdict), ['warn', 'warn']);
  assert.equal(requests.length, 2);
  await check.run(context(root, client));
  assert.equal(requests.length, 4, 'degraded verdicts must retry, not stick');
});

test('judge payload carries the real import graph and the file kind', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'c.ts'), 'export const c = 1;\n');
  const { client, requests } = countingClient((request) =>
    request.user.includes('Kind: new')
      ? { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } }
      : { ok: true, verdict: HELD_VERDICT },
  );
  await check.run(context(root, client, ['a.ts', 'b.ts', 'c.ts']));
  const forA = requests.find((r) => r.user.includes('File: a.ts'))!;
  const forB = requests.find((r) => r.user.includes('File: b.ts'))!;
  const forC = requests.find((r) => r.user.includes('File: c.ts'))!;
  assert.ok(forA.user.includes('b.ts'), 'a.ts imports b.ts');
  assert.match(forB.user, /Head imported by \(paths only\):\na\.ts/);
  assert.match(forB.user, /Kind: legacy/);
  assert.match(forC.user, /Kind: new/);
});

test('explicit paths are normalized and deduplicated: one judgment, one verdict', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));
  const verdicts = await check.run(context(root, client, ['a.ts', './a.ts', 'a.ts']));
  assert.equal(requests.length, 1, 'duplicate inputs must not bill twice');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.file, 'a.ts');
});

test('operational bounds: max_tokens 4096 and observed concurrency never above 3', async () => {
  const { root, git } = tempRepo();
  for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `f${i}.ts`), `export const f${i} = ${i};\n`);
  git('add', '.');
  git('commit', '-m', 'more files', '--quiet');
  let inFlight = 0;
  let maxInFlight = 0;
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } }));
  const gated: JudgeClient = {
    ...client,
    judge: async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await client.judge(request);
      inFlight -= 1;
      return result;
    },
  };
  const files = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
  const verdicts = await check.run(context(root, gated, files, 'base'));
  assert.equal(requests.length, 6);
  assert.ok(maxInFlight <= 3, `observed concurrency ${maxInFlight}`);
  assert.ok(requests.every((r) => r.maxTokens === 4096));
  assert.deepEqual(verdicts.map((v) => v.file), files, 'result order matches input order');
});

test('the cache is pair-addressed: the same head against a different base rejudges', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b + 1;\n`);
  git('commit', '-am', 'change a', '--quiet');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } }));
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 1);
  // Same semantic pair on a rerun: hit.
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 1, 'same pair must hit');
  // Base moves under the same head: different pair, must rejudge.
  git('branch', '-f', 'base', 'main');
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 2, 'same head against a different base must miss');
});
