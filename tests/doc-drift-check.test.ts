import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/doc-drift/index.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const ALIGNED = { assessment: 'aligned', findings: [], reasoning_summary: 'holds' };

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

/** A repo whose README references src/lib.ts (path + symbol) and whose
 * docs/other.md references nothing that will change. */
function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-drift-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 3;\nexport function libEntry() {}\n');
  writeFileSync(join(root, 'src/other.ts'), 'export const other = 1;\n');
  writeFileSync(join(root, 'README.md'), 'The limit lives in [lib.ts](src/lib.ts): `LIMIT` is 3.\n');
  writeFileSync(join(root, 'docs/other.md'), 'Nothing here references changed code, only `unrelatedName`.\n');
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  return { root, git };
}

function context(root: string, client: JudgeClient, files: string[], baseRef = 'main') {
  return { repoRoot: root, baseRef, files, client, cache: new VerdictCache(join(root, '.cache', 'aca'), check.name) };
}

test('only docs whose references intersect changed referents are judged — one call per candidate', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 5;\nexport function libEntry() {}\n');
  git('add', '.');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  const verdicts = await check.run(context(root, client, ['src/lib.ts']));
  assert.equal(requests.length, 1, 'exactly one candidate doc');
  assert.deepEqual(verdicts.map((v) => v.file), ['README.md']);
  assert.match(requests[0]!.user, /LIMIT = 5/);
});

test('an unchanged referent makes zero judge calls; a changed doc alone is not a candidate', async () => {
  const { root, git } = tempRepo();
  // Change only the unreferenced file, and edit a doc.
  writeFileSync(join(root, 'src/other.ts'), 'export const other = 2;\n');
  writeFileSync(join(root, 'docs/other.md'), 'Edited prose, still `unrelatedName` only.\n');
  git('add', '.');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  const verdicts = await check.run(context(root, client, ['src/other.ts']));
  assert.equal(requests.length, 0);
  assert.deepEqual(verdicts, []);
});

test('a deleted referent reaches the judge as a candidate even though the shared selector omits it', async () => {
  const { root, git } = tempRepo();
  rmSync(join(root, 'src/lib.ts'));
  git('add', '.');
  // The dispatcher's diff (--diff-filter=d) would not list src/lib.ts.
  const { client, requests } = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  await check.run(context(root, client, []));
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.user, /DELETED at head/);
});

test('cacheable verdicts hit on a second run; degraded verdicts retry', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 5;\nexport function libEntry() {}\n');
  git('add', '.');
  const ok = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  const first = await check.run(context(root, ok.client, ['src/lib.ts']));
  assert.deepEqual(first.map((v) => [v.verdict, v.cached]), [['pass', false]]);
  const second = await check.run(context(root, ok.client, ['src/lib.ts']));
  assert.equal(ok.requests.length, 1, 'cache hit must not call the judge');
  assert.deepEqual(second.map((v) => [v.verdict, v.cached]), [['pass', true]]);

  const failing = countingClient(() => ({ ok: false, note: 'overloaded' }));
  const cacheless = new VerdictCache(join(root, '.cache', 'aca2'), check.name);
  const degraded = await check.run({ repoRoot: root, baseRef: 'main', files: ['src/lib.ts'], client: failing.client, cache: cacheless });
  assert.deepEqual(degraded.map((v) => v.verdict), ['warn']);
  await check.run({ repoRoot: root, baseRef: 'main', files: ['src/lib.ts'], client: failing.client, cache: cacheless });
  assert.equal(failing.requests.length, 2, 'degraded verdicts must retry, not stick');
});

test('the cache misses when the doc or the referent content changes', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 5;\nexport function libEntry() {}\n');
  git('add', '.');
  const { client, requests } = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  await check.run(context(root, client, ['src/lib.ts']));
  assert.equal(requests.length, 1);
  writeFileSync(join(root, 'README.md'), 'The limit lives in [lib.ts](src/lib.ts): `LIMIT` is 5.\n');
  await check.run(context(root, client, ['src/lib.ts']));
  assert.equal(requests.length, 2, 'doc content is a semantic input');
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 7;\nexport function libEntry() {}\n');
  await check.run(context(root, client, ['src/lib.ts']));
  assert.equal(requests.length, 3, 'referent content is a semantic input');
});

test('verdicts carry the audit fields the JSON contract promises', async () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'src/lib.ts'), 'export const LIMIT = 5;\nexport function libEntry() {}\n');
  git('add', '.');
  const { client } = countingClient(() => ({ ok: true, verdict: ALIGNED }));
  const [verdict] = (await check.run(context(root, client, ['src/lib.ts']))) as unknown as [
    { scanMode?: string; references?: { id: string }[]; referents?: { path: string }[] },
  ];
  assert.equal(verdict.scanMode, 'explicit-markdown-references');
  assert.ok(verdict.references!.length >= 1);
  assert.deepEqual(verdict.referents!.map((r) => r.path), ['src/lib.ts']);
});
