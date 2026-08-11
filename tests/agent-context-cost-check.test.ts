import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/agent-context-cost/index.ts';
import type { AgentContextCostVerdict } from '../src/checks/agent-context-cost/judge-io.ts';
import { defaultEstimator } from '../src/corpora/instructions/index.ts';
import type { JudgeClient } from '../src/core/judge-client.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';

const DENSE = { assessment: 'dense', value_summary: 'earns its tokens', findings: [], reasoning_summary: 'rs' };

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'aca-cost-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function client(reply: unknown = DENSE): JudgeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: 'stub',
    model: 'stub-model',
    calls,
    judge: async ({ user }) => {
      calls.push(user);
      return { ok: true, verdict: reply };
    },
  };
}

const context = (root: string, files: string[], judge: JudgeClient) => ({
  repoRoot: root,
  baseRef: 'origin/main',
  files,
  client: judge,
  cache: new VerdictCache(join(root, '.cache', 'aca'), check.name),
});

test('a directory target judges every source in scope; unverified sources warn without spend', async () => {
  const root = repo({ 'AGENTS.md': '# tribal knowledge\nNever bump pg past 8.11 — silent corruption.\n', '.cursorrules': 'legacy\n' });
  try {
    const judge = client();
    const verdicts = (await check.run(context(root, ['.'], judge))) as AgentContextCostVerdict[];
    const byFile = new Map(verdicts.map((v) => [v.file, v]));
    assert.equal(byFile.get('AGENTS.md')!.verdict, 'pass');
    assert.equal(byFile.get('AGENTS.md')!.assessment, 'dense');
    const legacy = byFile.get('.cursorrules')!;
    assert.equal(legacy.verdict, 'warn');
    assert.match(legacy.note!, /semantics unverified — not judged/);
    assert.equal(judge.calls.length, 1, 'the unverified source costs no judge call');
    assert.ok(judge.calls[0]!.includes('# tribal knowledge'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verdicts carry the mechanical frame: estimates, bindings, load-set memberships', async () => {
  const root = repo({ 'AGENTS.md': 'twelve bytes\n' });
  try {
    const verdicts = (await check.run(context(root, ['.'], client()))) as AgentContextCostVerdict[];
    const verdict = verdicts[0]!;
    assert.equal(verdict.sourceId, 'repo:AGENTS.md');
    assert.equal(verdict.bytes, 13);
    assert.equal(verdict.estimatedTokens, defaultEstimator.estimate('twelve bytes\n'));
    const tools = new Set(verdict.bindings!.map((b) => b.tool));
    for (const tool of ['codex', 'copilot', 'cursor', 'windsurf-devin']) {
      assert.ok(tools.has(tool), `root AGENTS.md is paid by ${tool}`);
    }
    const setIds = verdict.loadSets!.map((s) => s.id);
    assert.ok(setIds.includes('codex-local@.'));
    assert.ok(setIds.includes('copilot-code-review@.'));
    assert.ok(!setIds.some((id) => id.startsWith('claude-')), 'Claude sessions do not load AGENTS.md');
    for (const set of verdict.loadSets!) {
      assert.equal(set.baselineTokens, defaultEstimator.estimate('twelve bytes\n'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file target selects the load sets that apply to it; targets deduplicate', async () => {
  const root = repo({ 'AGENTS.md': 'root rules\n', 'src/x.ts': 'export {};\n' });
  try {
    const judge = client();
    const verdicts = await check.run(context(root, ['src/x.ts', './src/x.ts', 'AGENTS.md'], judge));
    assert.equal(judge.calls.length, 1, 'one unique source, one judgment');
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.file, 'AGENTS.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a target in a bare subtree selects the nearest ancestor class, never every class', async () => {
  const root = repo({
    'AGENTS.md': 'root rules\n',
    'pkg/AGENTS.md': 'pkg rules\n',
    'docs/guide.md': 'plain docs\n',
  });
  try {
    const judge = client();
    // docs/ has no instruction files beneath it; its nearest ancestor class
    // is the root class, whose codex chain excludes pkg/AGENTS.md.
    const verdicts = await check.run(context(root, ['docs/guide.md'], judge));
    const files = verdicts.map((v) => v.file).sort();
    assert.deepEqual(files, ['AGENTS.md'], 'pkg-scoped source is out of scope for a docs/ target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file target passes itself as a touched path, so applyTo-scoped instructions are selected', async () => {
  const root = repo({
    '.github/copilot-instructions.md': 'repo-wide\n',
    '.github/instructions/api.instructions.md': '---\napplyTo: "src/**"\n---\nAPI rules.\n',
  });
  try {
    const judge = client();
    const verdicts = await check.run(context(root, ['src/server.ts'], judge));
    const files = verdicts.map((v) => v.file).sort();
    assert.ok(files.includes('.github/instructions/api.instructions.md'),
      'the glob-scoped instruction fires for the touched target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config exclude globs keep fixture trees out of the corpus and its load-set classes', async () => {
  const root = repo({
    'aca.config.json': JSON.stringify({ include: ['**'], exclude: ['tests/fixtures/**'] }),
    'AGENTS.md': 'root rules\n',
    'tests/fixtures/corpus/repo/AGENTS.md': 'planted padded rules\n',
  });
  try {
    const judge = client();
    const verdicts = (await check.run(context(root, ['.'], judge))) as AgentContextCostVerdict[];
    assert.deepEqual(verdicts.map((v) => v.file), ['AGENTS.md'], 'the planted source is never selected');
    assert.equal(judge.calls.length, 1, 'the planted source costs no judge call');
    assert.ok(
      verdicts[0]!.loadSets!.every((set) => !set.id.includes('tests/fixtures')),
      'no phantom load-set class from the fixture directory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no targets → no verdicts and zero judge calls; empty corpus likewise', async () => {
  const root = repo({ 'AGENTS.md': 'rules\n' });
  const bare = repo({ 'src/x.ts': 'export {};\n' });
  try {
    const judge = client();
    assert.deepEqual(await check.run(context(root, [], judge)), []);
    assert.deepEqual(await check.run(context(bare, ['.'], judge)), []);
    assert.equal(judge.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('second identical run hits the cache — zero additional judge calls, decoration fresh', async () => {
  const root = repo({ 'AGENTS.md': 'stable content\n' });
  try {
    const judge = client();
    const first = (await check.run(context(root, ['.'], judge))) as AgentContextCostVerdict[];
    assert.equal(first[0]!.cached, false);
    const second = (await check.run(context(root, ['.'], judge))) as AgentContextCostVerdict[];
    assert.equal(judge.calls.length, 1, 'an unchanged corpus makes zero additional judge calls');
    assert.equal(second[0]!.cached, true);
    assert.equal(second[0]!.verdict, 'pass');
    assert.deepEqual(second[0]!.loadSets, first[0]!.loadSets, 'mechanical decoration is recomputed, not stale-cached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content change misses the cache; a degraded warn is never cached', async () => {
  const root = repo({ 'AGENTS.md': 'v1\n' });
  try {
    const judge = client();
    await check.run(context(root, ['.'], judge));
    writeFileSync(join(root, 'AGENTS.md'), 'v2\n');
    await check.run(context(root, ['.'], judge));
    assert.equal(judge.calls.length, 2, 'changed content re-judges');

    const failing: JudgeClient & { calls: string[] } = { ...client(), judge: async () => ({ ok: false, note: 'transient' }) };
    const degradedRoot = repo({ 'AGENTS.md': 'flaky\n' });
    try {
      const first = await check.run(context(degradedRoot, ['.'], failing));
      assert.equal(first[0]!.verdict, 'warn');
      const retry = client();
      const second = await check.run(context(degradedRoot, ['.'], retry));
      assert.equal(retry.calls.length, 1, 'a degraded result retries next run');
      assert.equal(second[0]!.verdict, 'pass');
    } finally {
      rmSync(degradedRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
