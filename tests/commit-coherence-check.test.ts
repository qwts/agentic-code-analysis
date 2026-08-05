import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, type CommitCoherenceVerdict } from '../src/checks/commit-coherence/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const COHERENT = { assessment: 'coherent', overall_intent: 'one change', findings: [], split_proposal: [], reasoning_summary: 'one intent' };

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
  const root = mkdtempSync(join(tmpdir(), 'aca-cc-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(root, 'c.ts'), 'export const c = 1;\n');
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
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));

  const first = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as CommitCoherenceVerdict[];
  assert.equal(requests.length, 1, 'one judge call per run regardless of file count');
  assert.ok(requests[0]!.user.includes('a.ts') && requests[0]!.user.includes('b.ts'), 'both files travel in the one payload');
  assert.match(requests[0]!.user, /Changed units/, 'the unit index travels with the diff');
  assert.deepEqual(first.map((v) => [v.file, v.verdict, v.cached]), [
    ['a.ts', 'pass', false],
    ['b.ts', 'pass', false],
  ]);
  assert.equal(first[0]!.run!.assessment, 'coherent');

  const second = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as CommitCoherenceVerdict[];
  assert.equal(requests.length, 1, 'an unchanged diff must make zero API calls');
  assert.deepEqual(second.map((v) => [v.verdict, v.cached]), [
    ['pass', true],
    ['pass', true],
  ]);
  assert.equal(second[0]!.run!.cacheHit, true);
  assert.equal(second[0]!.run!.judgeCalls, 0);
});

test('an entangled judgment projects onto the cited files with the split as suggestion; uncited files pass', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
  const { client } = countingClient(() => ({
    ok: true,
    verdict: {
      assessment: 'entangled',
      overall_intent: 'two intents',
      findings: [{ criterion: 'unrelated-changes', files: ['a.ts'], evidence: 'a.ts change is independent of b.ts' }],
      split_proposal: [
        { name: 'first', intent: 'the a change', units: ['a.ts'] },
        { name: 'second', intent: 'the b change', units: ['b.ts'] },
      ],
      reasoning_summary: 'two unrelated intents',
    },
  }));
  const verdicts = (await check.run(context(root, client, ['a.ts', 'b.ts']))) as CommitCoherenceVerdict[];
  const a = verdicts.find((v) => v.file === 'a.ts')!;
  const b = verdicts.find((v) => v.file === 'b.ts')!;
  assert.equal(a.verdict, 'fail');
  assert.equal(a.violations[0]!.criterion, 'unrelated-changes');
  assert.match(a.violations[0]!.evidence, /^a\.ts — /, 'rendered evidence is prefixed with the cited files');
  assert.match(a.violations[0]!.suggestion, /^split into: "first" — a\.ts; "second" — b\.ts$/);
  assert.equal(b.verdict, 'pass', 'a fail is anchored to the cited files, not smeared');
  assert.equal(a.run!.splitProposal!.length, 2, 'the structured proposal survives for --json');
});

test('scoped files with no diff pass without judging; an all-unchanged scope makes zero calls', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));
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

test('a deletion enters the judged artifact and gets its own row, even though scope cannot name it', async () => {
  const { root } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  rmSync(join(root, 'c.ts'));
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));
  const verdicts = (await check.run(context(root, client, ['a.ts']))) as CommitCoherenceVerdict[];
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.user, /c\.ts \(deleted\)/, 'the judge sees the deletion');
  assert.deepEqual(
    verdicts.map((v) => [v.file, v.verdict, v.note]),
    [
      ['a.ts', 'pass', undefined],
      ['c.ts', 'pass', 'deleted vs merge-base'],
    ],
    'the deleted path gets a verdict row',
  );
});

test('a deletion-only change is judged despite the empty change scope', async () => {
  const { root } = tempRepo();
  rmSync(join(root, 'c.ts'));
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));
  const verdicts = (await check.run(context(root, client, []))) as CommitCoherenceVerdict[];
  assert.equal(requests.length, 1, 'change scope drops deletions, so an empty scope must still reach the artifact');
  assert.deepEqual(
    verdicts.map((v) => [v.file, v.verdict, v.note]),
    [['c.ts', 'pass', 'deleted vs merge-base']],
  );

  // A different selection over the identical artifact is a cache hit.
  const reselected = await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 1, 'the key is the artifact, not the selection');
  assert.deepEqual(
    reselected.map((v) => [v.file, v.verdict]),
    [
      ['a.ts', 'pass'],
      ['c.ts', 'pass'],
    ],
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
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 1);

  git('commit', '-qam', 'same content');
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 1, 'same diff content must hit whatever the branch state');

  writeFileSync(join(root, 'a.ts'), 'export const a = 3;\n');
  await check.run(context(root, client, ['a.ts']));
  assert.equal(requests.length, 2, 'a changed diff must rejudge');

  const other = countingClient(() => ({ ok: true, verdict: COHERENT }), 'other-model');
  await check.run(context(root, other.client, ['a.ts']));
  assert.equal(other.requests.length, 1, 'a different model must not share verdicts');
});

test('a bounded payload is never judged: zero calls, every row warns naming the omitted files', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
  const bigLine = 'export const filler = 1; // padding to overflow the payload bound with room to spare\n';
  writeFileSync(join(root, 'big.ts'), bigLine.repeat(2000));
  git('add', 'big.ts');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: COHERENT }));

  const verdicts = (await check.run(context(root, client, ['a.ts', 'big.ts']))) as CommitCoherenceVerdict[];
  assert.equal(requests.length, 0, 'coherence over a partial view is unsound — no call');
  for (const v of verdicts) {
    assert.equal(v.verdict, 'warn', `${v.file}: unjudged material can never pass`);
    assert.match(v.note!, /not judged/);
    assert.match(v.note!, /big\.ts/, 'the omission is named');
  }

  // The rerun still makes no call and nothing was cached.
  await check.run(context(root, client, ['a.ts', 'big.ts']));
  assert.equal(requests.length, 0);
});
