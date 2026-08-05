import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/naming-truth/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  before_behavior: 'a pure constant module',
  after_behavior: 'a pure constant module',
  comparison_evidence: 'no behavioral movement',
  head_findings: [],
  reasoning_summary: 'Names truthful at both ends.',
};

const FINDING = {
  criterion: 'name-omits-side-effect',
  symbol: 'getUser',
  symbol_kind: 'function',
  name_claim: 'a pure read',
  actual_behavior: 'also writes last-seen',
  evidence: 'db.updateLastSeen(id)',
  suggested_name: 'recordAccessAndGetUser',
  change: 'introduced',
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
  const root = mkdtempSync(join(tmpdir(), 'aca-nt-check-'));
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

test('at most three judge requests are in flight; output order follows input order', async () => {
  const { root } = tempRepo();
  const files = ['c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts'];
  for (const file of files) writeFileSync(join(root, file), `export const x_${file[0]} = 1;\n`);
  let inFlight = 0;
  let peak = 0;
  const client: JudgeClient = {
    provider: 'stub',
    model: 'stub-model',
    judge: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } };
    },
  };
  const verdicts = await check.run(context(root, client, files));
  assert.ok(peak <= 3, `pool must cap concurrency at 3, saw ${peak}`);
  assert.deepEqual(verdicts.map((v) => v.file), files, 'verdict order must follow input order');
});

test('the cache is pair-addressed: the same head against a different base rejudges', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), `import { b } from './b.ts';\nexport const a = b + 1;\n`);
  git('commit', '-am', 'change a', '--quiet');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } }));
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 1);
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 1, 'same pair must hit');
  git('branch', '-f', 'base', 'main');
  await check.run(context(root, client, ['a.ts'], 'base'));
  assert.equal(requests.length, 2, 'same head against a different base must miss');
});

test('self-test passes when fixtures judge as expected, fails on a miss', async () => {
  const byFixture = (request: JudgeRequest): JudgeResult => {
    const { user } = request;
    if (user.includes('function assertValidOrder') || user.includes('function processEvents')) {
      return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } };
    }
    if (user.includes('function isValidOrder')) {
      return {
        ok: true,
        verdict: {
          ...HELD_VERDICT,
          assessment: 'new-violating',
          head_findings: [{ ...FINDING, criterion: 'name-contradicts-behavior', symbol: 'isValidOrder' }],
        },
      };
    }
    if (user.includes('updateLastSeen')) {
      return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'regressed', head_findings: [FINDING] } };
    }
    // session-store pair: improved, one unchanged lie left
    return {
      ok: true,
      verdict: {
        ...HELD_VERDICT,
        assessment: 'improved',
        head_findings: [{ ...FINDING, symbol: 'countSessions', change: 'unchanged' }],
      },
    };
  };
  const good = await check.selfTest!({ provider: 'stub', model: 'm', judge: async (r) => byFixture(r) });
  assert.equal(good.passed, true, good.lines.join('\n'));
  assert.equal(good.lines.filter((l) => l.startsWith('ok ')).length, 5);

  // An improvement that fails to record the known remaining lie is a miss:
  // the graded fixture requires the residual, not just the pass.
  const noResidual = await check.selfTest!({
    provider: 'stub',
    model: 'm',
    judge: async (r) => {
      const result = byFixture(r);
      if (result.ok && r.user.includes('getSessionAndRefreshExpiry')) return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
      return result;
    },
  });
  assert.equal(noResidual.passed, false);
  assert.ok(noResidual.lines.some((l) => l.startsWith('MISS legacy-improved-with-residual')));

  const alwaysHeld = await check.selfTest!({ provider: 'stub', model: 'm', judge: async () => ({ ok: true, verdict: HELD_VERDICT }) });
  assert.equal(alwaysHeld.passed, false, 'the lying fixtures are the negative control');
  assert.ok(alwaysHeld.lines.some((l) => l.startsWith('MISS new-lying-predicate')));
  assert.ok(alwaysHeld.lines.some((l) => l.startsWith('MISS legacy-gains-hidden-write')));
});
