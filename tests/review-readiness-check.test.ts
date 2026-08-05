import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, type ReviewReadinessVerdict } from '../src/checks/review-readiness/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const READY = { assessment: 'ready', findings: [], reasoning_summary: 'clean' };

function countingClient(
  result: (request: JudgeRequest) => JudgeResult,
  model = 'stub-model',
): { client: JudgeClient; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      provider: 'stub',
      model,
      judge: async (request) => {
        requests.push(request);
        return result(request);
      },
    },
  };
}

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-rr-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  return { root, git };
}

function context(root: string, client: JudgeClient, files: string[], baseRef = 'main') {
  return { repoRoot: root, baseRef, files, client, cache: new VerdictCache(join(root, '.cache', 'aca'), check.name) };
}

test('whole-artifact judgment: multiple changed files cost exactly one request; a rerun costs zero', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), "export const a = 1;\nconsole.log('DBG');\n");
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: READY }));

  const first = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as ReviewReadinessVerdict[];
  assert.equal(requests.length, 1, 'one judge call per run regardless of file count');
  assert.ok(requests[0]!.user.includes('a.ts') && requests[0]!.user.includes('b.ts'), 'both files travel in the one payload');
  assert.deepEqual(first.map((v) => [v.file, v.verdict, v.cached]), [
    ['a.ts', 'pass', false],
    ['b.ts', 'pass', false],
  ]);
  assert.deepEqual(first.map((v) => v.run!.judgeCalls), [1, 1]);

  const second = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as ReviewReadinessVerdict[];
  assert.equal(requests.length, 1, 'an unchanged diff must make zero API calls');
  assert.deepEqual(second.map((v) => [v.verdict, v.cached]), [
    ['pass', true],
    ['pass', true],
  ]);
  assert.equal(second[0]!.run!.cacheHit, true);
  assert.equal(second[0]!.run!.judgeCalls, 0);
});

test('findings project onto their files with path:line evidence; clean files pass; the structured line survives', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), "export const a = 1;\nconsole.log('DBG');\n");
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
  const finding = {
    criterion: 'leftover-debug',
    file: 'a.ts',
    line: 2,
    evidence: "console.log('DBG') serves the author, not the code",
    suggestion: 'delete the print',
  };
  const { client } = countingClient(() => ({
    ok: true,
    verdict: { assessment: 'not-ready', findings: [finding], reasoning_summary: 'debug print left in' },
  }));
  const verdicts = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as ReviewReadinessVerdict[];
  const a = verdicts.find((v) => v.file === 'a.ts')!;
  const b = verdicts.find((v) => v.file === 'b.ts')!;
  assert.equal(a.verdict, 'fail');
  assert.equal(a.violations[0]!.criterion, 'leftover-debug');
  assert.match(a.violations[0]!.evidence, /^a\.ts:2 — /, 'rendered evidence is anchored path:line');
  assert.deepEqual(a.findings, [finding], 'structured finding keeps the numeric line for --json');
  assert.equal(b.verdict, 'pass', 'a fail elsewhere in the diff does not smear onto clean files');
});

test('scoped files with no diff pass without judging; an all-unchanged scope makes zero calls', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: READY }));
  const verdicts = await check.run(context(root, client, ['a.ts', './a.ts', 'b.ts']));
  assert.equal(requests.length, 0, 'nothing changed, nothing to judge');
  assert.deepEqual(
    verdicts.map((v) => [v.file, v.verdict, v.note]),
    [
      ['a.ts', 'pass', 'no changes vs merge-base'],
      ['b.ts', 'pass', 'no changes vs merge-base'],
    ],
    'explicit paths are normalized and deduplicated',
  );
});

test('degraded judgments are not cached: the next run retries', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  const { client, requests } = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const first = await check.run(context(root, client, ['a.ts']));
  assert.deepEqual(first.map((v) => v.verdict), ['warn']);
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 2, 'degraded outcomes must retry, not stick');
});

test('the cache key is the artifact: diff content and model identity invalidate; branch state does not', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: READY }));
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 1);

  // Committing the identical working tree does not change the diff: hit.
  git('commit', '-qam', 'same content');
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 1, 'same diff content must hit whatever the branch state');

  // Content change: miss.
  writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 2, 'a changed diff must rejudge');

  // Same diff, different model: miss.
  const other = countingClient(() => ({ ok: true, verdict: READY }), 'other-model');
  await check.run(context(root, other.client, ['a.ts']));
  assert.equal(other.requests.length, 1, 'a different model must not share verdicts');
});

test('over-bound files are omitted from the payload, warn by name, and their content still keys the cache', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  const bigLine = 'export const filler = 1; // padding to overflow the payload bound with room to spare\n';
  writeFileSync(join(root, 'big.ts'), bigLine.repeat(2000));
  // New files enter the diff once staged — same visibility change scope has.
  git('add', 'big.ts');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: READY }));

  const verdicts = (await check.run(context(root, client, ['a.ts', 'big.ts']))) as ReviewReadinessVerdict[];
  assert.equal(requests.length, 1);
  assert.ok(!requests[0]!.user.includes('filler'), 'omitted content must not reach the judge');
  const big = verdicts.find((v) => v.file === 'big.ts')!;
  assert.equal(big.verdict, 'warn', 'unjudged material can never pass');
  assert.match(big.note!, /not judged/);
  assert.match(big.note!, /\+1,2000/, 'the omission names the unjudged head hunks');
  assert.equal(verdicts.find((v) => v.file === 'a.ts')!.verdict, 'pass', 'judged files still get their verdict');
  assert.deepEqual(big.run!.omitted, [{ path: 'big.ts', hunks: ['+1,2000'] }]);

  // A change confined to the omitted file must invalidate the cached judgment.
  writeFileSync(join(root, 'big.ts'), bigLine.repeat(2000) + 'export const tail = 1;\n');
  await check.run(context(root, client, ['a.ts', 'big.ts']));
  assert.equal(requests.length, 2, 'omitted content is still part of the artifact identity');
});
