import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/context-footprint/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_practical_test: 'this file alone',
  after_practical_test: 'this file alone',
  comparison_evidence: 'no structural movement',
  head_violations: [],
  reasoning_summary: 'Coherent at both ends.',
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
  const root = mkdtempSync(join(tmpdir(), 'aca-check-'));
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

test('self-test passes when fixtures judge as expected, fails on a miss', async () => {
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
  const good = await check.selfTest!({ provider: 'stub', model: 'm', judge: async (r) => byFixture(r) });
  assert.equal(good.passed, true, good.lines.join('\n'));
  assert.equal(good.lines.filter((l) => l.startsWith('ok ')).length, 5);

  // An improvement that fails to name the known residual debt is a miss:
  // the graded fixture requires the residual criteria, not just the pass.
  const noResidual = await check.selfTest!({
    provider: 'stub',
    model: 'm',
    judge: async (r) => {
      const result = byFixture(r);
      if (result.ok && r.user.includes('shrank from 550 to 356')) return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
      return result;
    },
  });
  assert.equal(noResidual.passed, false);
  assert.ok(noResidual.lines.some((l) => l.startsWith('MISS legacy-improved-residual')));

  const alwaysHeld = await check.selfTest!({ provider: 'stub', model: 'm', judge: async () => ({ ok: true, verdict: HELD_VERDICT }) });
  assert.equal(alwaysHeld.passed, false, 'the regression fixtures are the negative control');
  assert.ok(alwaysHeld.lines.some((l) => l.startsWith('MISS new-enumerated')));
  assert.ok(alwaysHeld.lines.some((l) => l.startsWith('MISS legacy-enumerated-back')));
});
