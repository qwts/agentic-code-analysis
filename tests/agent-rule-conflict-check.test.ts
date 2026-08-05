// End-to-end through the production path: real corpus discovery over the
// check's own fixture trees, a fake JudgeClient, and the per-partition cache.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, judgeCorpus } from '../src/checks/agent-rule-conflict/index.ts';
import { CORPUS_ROW, type ConflictVerdict } from '../src/checks/agent-rule-conflict/outcome.ts';
import { conflictsFound, fakeClient, memoryCache, noConflict } from './agent-rule-conflict-helpers.ts';

const FIXTURES = join(import.meta.dirname, '..', 'src', 'checks', 'agent-rule-conflict', 'fixtures');
const CROSS_FILE = join(FIXTURES, 'cross-file', 'repo');

const QUOTE_A = 'This repository uses pnpm exclusively — always install dependencies with pnpm, and treat any npm lockfile as an error.';
const QUOTE_B = 'Install dependencies with npm only; never use pnpm in this repository.';

const crossFileReply = () =>
  conflictsFound([
    {
      criterion: 'direct-contradiction',
      rule_a: { source_id: 'repo:.github/copilot-instructions.md', quote: QUOTE_A },
      rule_b: { source_id: 'repo:AGENTS.md', quote: QUOTE_B },
      explanation: 'npm-only and pnpm-only cannot both be followed',
      resolution: 'consolidate',
      suggestion: 'pick one package manager and state it in both files',
    },
  ]);

test('a fitting corpus makes one judge call; the finding carries verified shared sessions', async () => {
  const client = fakeClient([crossFileReply()]);
  const cache = memoryCache();
  const verdicts = await judgeCorpus(CROSS_FILE, client, cache, []);
  assert.equal(client.requests.length, 1);
  const corpusRow = verdicts.find((v) => v.file === CORPUS_ROW)!;
  assert.equal(corpusRow.partitions!.length, 1);
  assert.equal(corpusRow.partitions![0]!.kind, 'whole-corpus');
  const row = verdicts.find((v) => v.file === '.github/copilot-instructions.md')!;
  assert.equal(row.verdict, 'fail');
  const finding = row.findings![0]!;
  assert.ok(finding.sessionsLoadingBoth.includes('copilot-cli@.'));
  assert.equal(finding.ruleA.quote, QUOTE_A);
  assert.ok(finding.ruleA.startLine >= 1);
  // The judge saw the serialized artifact, never loose prose.
  assert.match(client.requests[0]!.user, /^<corpus-artifact>/);
  assert.equal(cache.store.size, 1);
});

test('an identical second run costs zero judge calls and reports the cache hit', async () => {
  const client = fakeClient([crossFileReply()]);
  const cache = memoryCache();
  await judgeCorpus(CROSS_FILE, client, cache, []);
  const again = await judgeCorpus(CROSS_FILE, fakeClient([noConflict()]), cache, []);
  const corpusRow = again.find((v) => v.file === CORPUS_ROW)!;
  assert.equal(corpusRow.partitions![0]!.status, 'cached');
  assert.equal(corpusRow.cached, true);
  assert.equal(again.find((v) => v.file === '.github/copilot-instructions.md')!.cached, true);
});

test('a different corpus, provider, or model misses the cache', async () => {
  const cache = memoryCache();
  await judgeCorpus(CROSS_FILE, fakeClient([crossFileReply()]), cache, []);
  // Different tree -> different payload -> second entry, no false hit.
  const withinFile = join(FIXTURES, 'within-file', 'repo');
  const client2 = fakeClient([noConflict()]);
  await judgeCorpus(withinFile, client2, cache, []);
  assert.equal(client2.requests.length, 1);
  assert.equal(cache.store.size, 2);
  // Same tree, different model identity -> miss.
  const otherModel = { ...fakeClient([noConflict()]), model: 'other-model' };
  await judgeCorpus(CROSS_FILE, otherModel, cache, []);
  assert.equal(cache.store.size, 3);
});

test('degraded replies warn and are never cached', async () => {
  const client = fakeClient([{ ok: false, note: 'judge refused' }]);
  const cache = memoryCache();
  const verdicts = await judgeCorpus(CROSS_FILE, client, cache, []);
  const corpusRow = verdicts.find((v) => v.file === CORPUS_ROW)!;
  assert.equal(corpusRow.verdict, 'warn');
  assert.match(corpusRow.note!, /degraded/);
  assert.equal(cache.store.size, 0);
  // Next run retries.
  const retry = fakeClient([noConflict()]);
  await judgeCorpus(CROSS_FILE, retry, cache, []);
  assert.equal(retry.requests.length, 1);
});

test('a fabricated quote degrades the partition atomically', async () => {
  const bad = conflictsFound([
    {
      criterion: 'direct-contradiction',
      rule_a: { source_id: 'repo:AGENTS.md', quote: 'not in the file' },
      rule_b: { source_id: 'repo:.github/copilot-instructions.md', quote: QUOTE_A },
      explanation: 'e',
      resolution: 'consolidate',
      suggestion: 's',
    },
  ]);
  const verdicts = await judgeCorpus(CROSS_FILE, fakeClient([bad]), memoryCache(), []);
  assert.equal(verdicts.length, 1);
  const corpusRow = verdicts[0]!;
  assert.equal(corpusRow.file, CORPUS_ROW);
  assert.match(corpusRow.note!, /not found verbatim/);
});

test('config exclude globs keep planted trees out; an empty projection never judges', async () => {
  const client = fakeClient([noConflict()]);
  const verdicts = await judgeCorpus(CROSS_FILE, client, memoryCache(), ['**/*.md']);
  assert.equal(client.requests.length, 0);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, 'pass');
  assert.match(verdicts[0]!.note!, /no instruction corpus/);
  assert.deepEqual(verdicts[0]!.excludedSources, ['.github/copilot-instructions.md', 'AGENTS.md']);
});

test('empty target set runs nothing; an empty repo judges nothing', async () => {
  const client = fakeClient([noConflict()]);
  const cache = memoryCache();
  const none = await check.run({ repoRoot: CROSS_FILE, baseRef: 'origin/main', files: [], client, cache: cache as never });
  assert.deepEqual(none, []);
  assert.equal(client.requests.length, 0);

  const empty = mkdtempSync(join(tmpdir(), 'arc-empty-'));
  try {
    const verdicts = await judgeCorpus(empty, client, cache, []);
    assert.equal(client.requests.length, 0);
    assert.equal((verdicts[0] as ConflictVerdict).note, 'no instruction corpus');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
