import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checks } from '../src/checks/registry.ts';
import { check } from '../src/checks/seam-audit/index.ts';
import type { SeamAuditVerdict, SeamDependency } from '../src/checks/seam-audit/judge-io.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const HELD_VERDICT = {
  assessment: 'held',
  comparison_evidence: 'no seam movement',
  dependencies_without_seams: [],
  reasoning_summary: 'Same seams at both ends.',
};

function countingClient(result: (request: JudgeRequest) => JudgeResult, id = { provider: 'stub', model: 'stub-model' }) {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      ...id,
      judge: async (request: JudgeRequest) => {
        requests.push(request);
        return result(request);
      },
    } satisfies JudgeClient,
  };
}

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-seam-check-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'logic.ts'), 'export const run = (clock: () => number) => clock();\n');
  writeFileSync(join(root, 'leaf.ts'), 'export const LIMIT = 3;\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  git('branch', 'base');
  return { root, git };
}

function context(root: string, client: JudgeClient, files: string[], baseRef = 'main') {
  return { repoRoot: root, baseRef, files, client, cache: new VerdictCache(join(root, '.cache', 'aca'), check.name) };
}

test('the registry resolves seam-audit', async () => {
  const loaded = await checks.get('seam-audit')!();
  assert.equal(loaded.name, 'seam-audit');
  assert.equal(loaded.tier, 'T1');
  assert.ok(loaded.selfTest);
});

test('a proven leaf takes the mechanical path: zero judge calls, observable source, never cached', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'constants.ts'), "export const NAME = 'aca';\nexport type Mode = 'a' | 'b';\n");
  git('add', 'constants.ts');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-compliant' } }));

  const first = (await check.run(context(root, client, ['constants.ts']))) as SeamAuditVerdict[];
  assert.equal(requests.length, 0, 'a mechanically proven leaf must make zero judge requests');
  assert.equal(first[0]!.verdict, 'pass');
  assert.equal(first[0]!.assessment, 'new-compliant');
  assert.equal(first[0]!.source, 'mechanical-prefilter');
  assert.equal(first[0]!.cached, false);
  assert.deepEqual(first[0]!.testabilityFootprint, []);

  const second = (await check.run(context(root, client, ['constants.ts']))) as SeamAuditVerdict[];
  assert.equal(requests.length, 0);
  assert.equal(second[0]!.cached, false, 'mechanical passes are recomputed, not cached');
});

test('legacy with both ends proven leaf is mechanically held; a leaf at one end only judges', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'leaf.ts'), 'export const LIMIT = 4;\n');
  writeFileSync(join(root, 'logic.ts'), 'export const LIMIT = 4;\n'); // head leaf, base had logic
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HELD_VERDICT }));

  const verdicts = (await check.run(context(root, client, ['leaf.ts', 'logic.ts']))) as SeamAuditVerdict[];
  const leaf = verdicts.find((v) => v.file === 'leaf.ts')!;
  assert.equal(leaf.source, 'mechanical-prefilter');
  assert.equal(leaf.assessment, 'held');
  const logic = verdicts.find((v) => v.file === 'logic.ts')!;
  assert.equal(logic.source, 'judge');
  assert.equal(requests.length, 1, 'only the non-leaf end pays a judge call');
});

test('import-free ambient access reaches the judge, never the mechanical path', async () => {
  const { root, git } = tempRepo();
  const counterexamples: Record<string, string> = {
    'clock.ts': 'export const NOW = Date.now();\n',
    'random.ts': 'export const SEED = Math.random();\n',
    'net.ts': 'export const P = fetch("https://example.com");\n',
    'env.ts': 'export const KEY = process.env.KEY;\n',
    'client.ts': 'export const C = new Client("k");\n',
    'dyn.ts': 'export const M = import("./x.ts");\n',
    'cjs.ts': 'export const R = require("./x.ts");\n',
    'call.ts': 'setup();\nexport const READY = true;\n',
  };
  for (const [file, content] of Object.entries(counterexamples)) writeFileSync(join(root, file), content);
  git('add', '.');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating' } }));
  await check.run(context(root, client, Object.keys(counterexamples)));
  assert.equal(requests.length, Object.keys(counterexamples).length, 'every ambient counterexample must be judged');
});

test('judged verdicts cache; the second run is a hit and a moving merge-base misses', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'logic.ts'), 'export const run = (clock: () => number) => clock() + 1;\n');
  git('commit', '-am', 'change logic', '--quiet');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } }));

  await check.run(context(root, client, ['logic.ts'], 'base'));
  assert.equal(requests.length, 1);
  const second = await check.run(context(root, client, ['logic.ts'], 'base'));
  assert.equal(requests.length, 1, 'same semantic pair must hit');
  assert.equal(second[0]!.cached, true);

  git('branch', '-f', 'base', 'main');
  await check.run(context(root, client, ['logic.ts'], 'base'));
  assert.equal(requests.length, 2, 'same head against a different base must miss');
});

test('provider and model are semantic key components: changing either misses', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'logic.ts'), 'export const run = (clock: () => number) => clock() + 1;\n');
  git('commit', '-am', 'change logic', '--quiet');
  const result = () => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } }) as JudgeResult;
  const a = countingClient(result);
  await check.run(context(root, a.client, ['logic.ts'], 'base'));
  const otherModel = countingClient(result, { provider: 'stub', model: 'other-model' });
  await check.run(context(root, otherModel.client, ['logic.ts'], 'base'));
  assert.equal(otherModel.requests.length, 1, 'a different model must not reuse the verdict');
  const otherProvider = countingClient(result, { provider: 'other', model: 'stub-model' });
  await check.run(context(root, otherProvider.client, ['logic.ts'], 'base'));
  assert.equal(otherProvider.requests.length, 1, 'a different provider must not reuse the verdict');
});

test('degraded results are not cached: the next run retries the judge', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'logic.ts'), 'export const run = (clock: () => number) => clock() + 1;\n');
  git('commit', '-am', 'change logic', '--quiet');
  const { client, requests } = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const first = await check.run(context(root, client, ['logic.ts'], 'base'));
  assert.equal(first[0]!.verdict, 'warn');
  await check.run(context(root, client, ['logic.ts'], 'base'));
  assert.equal(requests.length, 2, 'degraded verdicts must retry, not stick');
});

test('explicit paths are normalized and deduplicated; output order is stable; concurrency stays at 3', async () => {
  const { root, git } = tempRepo();
  const files: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const file = `ambient-${i}.ts`;
    writeFileSync(join(root, file), `export const V${i} = Date.now();\n`);
    files.push(file);
  }
  git('add', '.');
  let inFlight = 0;
  let peak = 0;
  const { client, requests } = countingClient(() => ({ ok: true, verdict: { ...HELD_VERDICT, assessment: 'new-violating' } }));
  const gated: JudgeClient = {
    ...client,
    judge: async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await client.judge(request);
      inFlight -= 1;
      return result;
    },
  };
  const verdicts = await check.run(context(root, gated, [...files, './ambient-0.ts']));
  assert.equal(requests.length, files.length, 'duplicate inputs must not bill twice');
  assert.deepEqual(verdicts.map((v) => v.file), files, 'output order follows input order');
  assert.ok(peak <= 3, `worker pool must not exceed 3 concurrent requests (saw ${peak})`);
});

test('self-test positive and negative controls', async () => {
  const wrong = () => ({ ok: true, verdict: HELD_VERDICT }) as JudgeResult;
  const negative = countingClient(wrong);
  const failed = await check.selfTest!(negative.client);
  assert.equal(failed.passed, false, 'a judge that answers held everywhere must not qualify');

  const item = (dependency: string, criterion: string, change: string): SeamDependency =>
    ({
      dependency,
      criterion,
      change,
      access_point: 'submitWithRetry',
      evidence: `calls ${dependency} directly`,
      test_patch: `the global ${dependency}`,
      suggested_seam: 'inject a port',
    }) as SeamDependency;
  const calibrated = countingClient((request) => {
    const head = request.user.split('<head-content>')[1] ?? '';
    const injectedHead = head.includes('deps.clock');
    const items = (change: string) => [item('Date.now', 'ambient-state', change), item('globalThis.fetch', 'ambient-io', change)];
    if (request.user.includes('Kind: new')) {
      return {
        ok: true,
        verdict: injectedHead
          ? { ...HELD_VERDICT, assessment: 'new-compliant', comparison_evidence: '(none — new file)' }
          : { ...HELD_VERDICT, assessment: 'new-violating', comparison_evidence: '(none — new file)', dependencies_without_seams: items('new') },
      };
    }
    const injectedBase = (request.user.split('<base-content>')[1] ?? '').split('<head-content>')[0]!.includes('deps.clock');
    if (injectedHead) return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'improved' } };
    if (injectedBase) return { ok: true, verdict: { ...HELD_VERDICT, assessment: 'regressed', dependencies_without_seams: items('introduced') } };
    return { ok: true, verdict: { ...HELD_VERDICT, dependencies_without_seams: items('pre-existing') } };
  });
  const passed = await check.selfTest!(calibrated.client);
  assert.equal(passed.passed, true, passed.lines.join('\n'));
  const graded = passed as unknown as { report: { achievedLevel: string | null; requiredLevel: string } };
  assert.equal(graded.report.achievedLevel, 'field');
  assert.equal(graded.report.requiredLevel, 'field');
});
