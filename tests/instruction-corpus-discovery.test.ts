import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInstructionCorpus } from '../src/corpora/instructions/index.ts';
import { parseFrontmatter } from '../src/corpora/instructions/frontmatter.ts';
import {
  fakeEstimator,
  fixtureRoot,
  memoryFileSystem,
  recordingFileSystem,
} from './instruction-corpus-helpers.ts';

test('one physical file carries bindings for several tools without duplicate reads or charges', async () => {
  const recording = recordingFileSystem();
  const corpus = await discoverInstructionCorpus(
    { repoRoot: fixtureRoot('multi-tool/repo') },
    { estimator: fakeEstimator, fileSystem: recording.port },
  );

  const agents = corpus.files.find((file) => file.locator === 'repo:AGENTS.md');
  assert.ok(agents);
  const tools = new Set(agents!.bindings.map((binding) => binding.tool));
  assert.ok(tools.has('codex'));
  assert.ok(tools.has('copilot'));
  assert.ok(tools.has('cursor'));
  assert.ok(tools.has('windsurf-devin'));
  assert.ok(tools.has('claude-code'), 'CLAUDE.md @AGENTS.md import binds the same file for Claude');
  const profiles = agents!.bindings.map((binding) => binding.profile);
  assert.equal(new Set(profiles.map((p) => `${p}`)).size >= 6, true, 'many profiles, one file');

  // One list per root, one read per unique candidate.
  assert.deepEqual(recording.listCalls, [fixtureRoot('multi-tool/repo')]);
  const readCounts = new Map<string, number>();
  for (const call of recording.readCalls) readCounts.set(call, (readCounts.get(call) ?? 0) + 1);
  for (const [call, count] of readCounts) {
    assert.equal(count, 1, `${call} must be read exactly once`);
  }
  // Tokenized once per physical file: fullFile estimate present exactly once.
  assert.equal(corpus.files.filter((file) => file.locator === 'repo:AGENTS.md').length, 1);
});

test('corpus output is deterministic regardless of filesystem enumeration order', async () => {
  const trees = {
    '/repo': {
      'AGENTS.md': 'One file, many tools.\n',
      'CLAUDE.md': 'Project memory.\n',
      '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nRule body.\n',
      '.github/copilot-instructions.md': 'Repo-wide.\n',
    },
  };
  const sorted = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: memoryFileSystem(trees) },
  );
  const reversed = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: memoryFileSystem(trees, { listOrder: 'reversed' }) },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(sorted)), JSON.parse(JSON.stringify(reversed)));
});

test('a symlink escaping its authorized root degrades to a diagnostic, never content', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aca-corpus-'));
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  writeFileSync(join(scratch, 'outside.md'), 'secret outside content\n');
  symlinkSync(join(scratch, 'outside.md'), join(repo, 'AGENTS.md'));

  const corpus = await discoverInstructionCorpus({ repoRoot: repo }, { estimator: fakeEstimator });
  assert.ok(!corpus.files.some((file) => file.content.includes('secret')));
  assert.ok(corpus.diagnostics.some(
    (d) => d.locator === 'repo:AGENTS.md' && /outside its authorized root/.test(d.message),
  ));
});

test('unreadable and oversized candidates become diagnostics, not crashes or silent omissions', async () => {
  const big = 'x'.repeat(64);
  const fs = memoryFileSystem({ '/repo': { 'AGENTS.md': big, 'CLAUDE.md': 'ok\n' } });
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    {
      estimator: fakeEstimator,
      fileSystem: {
        ...fs,
        // AGENTS.md stats far over the byte cap; CLAUDE.md read throws.
        fileSize: async (root, rel) => (rel === 'AGENTS.md' ? 2 * 1024 * 1024 : fs.fileSize(root, rel)),
        readFile: async (root, rel) => {
          if (rel === 'CLAUDE.md') throw new Error('EACCES');
          return fs.readFile(root, rel);
        },
      },
    },
  );
  assert.ok(corpus.diagnostics.some((d) => d.locator === 'repo:AGENTS.md' && /exceeds/.test(d.message)));
  assert.ok(corpus.diagnostics.some((d) => d.locator === 'repo:CLAUDE.md' && /could not be read/.test(d.message)));
  assert.ok(!corpus.files.some((file) => file.content.length > 0));
});

test('a root over the entry cap yields an incomplete-discovery diagnostic instead of a partial scan', async () => {
  const tree: Record<string, string> = {};
  for (let index = 0; index < 50_001; index += 1) tree[`f${index}.txt`] = '';
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: memoryFileSystem({ '/repo': tree }) },
  );
  assert.ok(corpus.diagnostics.some((d) => /discovery for it is incomplete/.test(d.message)));
  assert.equal(corpus.files.length, 0);
});

test('request exclude globs drop matching paths before adapters see them', async () => {
  const trees = {
    '/repo': {
      'AGENTS.md': 'Real guidance.\n',
      'tests/fixtures/corpus/repo/AGENTS.md': 'Planted padded rules.\n',
      // A dot directory under the excluded tree: `**` must stay
      // dot-inclusive or planted rule files leak past the guard.
      'tests/fixtures/corpus/repo/.cursor/rules/planted.mdc': '---\nalwaysApply: true\n---\nPlanted rule.\n',
    },
  };
  const unfiltered = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: memoryFileSystem(trees) },
  );
  assert.ok(
    unfiltered.files.some((file) => file.path.startsWith('tests/fixtures/')),
    'without excludes the planted tree is discovered — the premise of this test',
  );

  const recording = recordingFileSystem(memoryFileSystem(trees));
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo', exclude: ['tests/fixtures/**'] },
    { estimator: fakeEstimator, fileSystem: recording.port },
  );
  assert.deepEqual(corpus.files.map((file) => file.locator), ['repo:AGENTS.md']);
  assert.ok(
    !recording.readCalls.some((call) => call.includes('tests/fixtures')),
    'an excluded candidate is never read',
  );
  assert.ok(corpus.diagnostics.some(
    (d) => d.severity === 'info' && /exclude globs \(tests\/fixtures\/\*\*\) skipped 2 path\(s\)/.test(d.message),
  ), 'the drop is recorded as a corpus diagnostic');
});

test('excluded paths never count toward the listing entry cap', async () => {
  const tree: Record<string, string> = { 'AGENTS.md': 'Real guidance.\n' };
  for (let index = 0; index < 50_001; index += 1) tree[`tests/fixtures/big/f${index}.txt`] = '';
  const fs = memoryFileSystem({ '/repo': tree });

  const capped = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    { estimator: fakeEstimator, fileSystem: fs },
  );
  assert.ok(
    capped.diagnostics.some((d) => /discovery for it is incomplete/.test(d.message)),
    'without excludes the tree alone crosses the cap — the premise of this test',
  );

  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo', exclude: ['tests/fixtures/**'] },
    { estimator: fakeEstimator, fileSystem: fs },
  );
  assert.deepEqual(corpus.files.map((file) => file.locator), ['repo:AGENTS.md']);
  assert.ok(
    !corpus.diagnostics.some((d) => /discovery for it is incomplete/.test(d.message)),
    'a huge excluded tree must not blank the root\'s discovery',
  );
});

test('root validation: relative paths, duplicate ids, and colon ids are usage errors', async () => {
  const fs = memoryFileSystem({ '/repo': {} });
  await assert.rejects(
    () => discoverInstructionCorpus({ repoRoot: 'relative/path' }, { fileSystem: fs, estimator: fakeEstimator }),
    /must be absolute/,
  );
  await assert.rejects(
    () =>
      discoverInstructionCorpus(
        { repoRoot: '/repo', userRoots: [{ id: 'repo', path: '/repo' }] },
        { fileSystem: fs, estimator: fakeEstimator },
      ),
    /duplicate root id/,
  );
  await assert.rejects(
    () =>
      discoverInstructionCorpus(
        { repoRoot: '/repo', userRoots: [{ id: 'a:b', path: '/repo' }] },
        { fileSystem: fs, estimator: fakeEstimator },
      ),
    /colon-free/,
  );
});

test('integration: this repository\'s tracked AGENTS.md maps with multi-tool bindings', async () => {
  const corpus = await discoverInstructionCorpus(
    { repoRoot: join(import.meta.dirname, '..') },
    { estimator: fakeEstimator },
  );
  const agents = corpus.files.find((file) => file.locator === 'repo:AGENTS.md');
  assert.ok(agents, 'the live repo corpus must include the root AGENTS.md');
  const tools = new Set(agents!.bindings.map((binding) => binding.tool));
  for (const tool of ['codex', 'copilot', 'cursor', 'windsurf-devin'] as const) {
    assert.ok(tools.has(tool), `root AGENTS.md is paid by ${tool}`);
  }
  assert.ok(agents!.fullFile.count > 0);
  assert.ok(agents!.bindings.every((binding) => binding.charged.tokens.estimator === 'fake-words@1'));
});

test('unterminated frontmatter keeps its raw block instead of an empty string', () => {
  const content = '---\nname: broken\nnever closed';
  const parsed = parseFrontmatter(content);
  assert.ok(parsed.present && 'error' in parsed && /unterminated/.test(parsed.error));
  assert.ok(parsed.present && 'raw' in parsed && parsed.raw === content);
});

test('containment accepts Windows-style realpaths for in-root files', async () => {
  const trees = { 'C:\\repo': { 'AGENTS.md': 'Windows guidance.\n' } };
  const fs = memoryFileSystem(trees);
  const corpus = await discoverInstructionCorpus(
    { repoRoot: 'C:\\repo' },
    {
      estimator: fakeEstimator,
      fileSystem: {
        ...fs,
        // Mimic win32 realpath(): backslash-separated absolute paths.
        realPath: async (rootPath, relPath) =>
          relPath === '' ? rootPath : `${rootPath}\\${relPath.replaceAll('/', '\\')}`,
      },
    },
  );
  const agents = corpus.files.find((file) => file.locator === 'repo:AGENTS.md');
  assert.ok(agents, 'an in-root file on a backslash filesystem must not read as escaping');
  assert.equal(agents!.content, 'Windows guidance.\n');
});

test('diagnostics from merge-time reads (skill resources) are not dropped', async () => {
  const fs = memoryFileSystem({
    '/repo': {
      '.claude/skills/tool/SKILL.md':
        '---\nname: tool\ndescription: A tool skill for testing.\n---\nBody.\n',
      '.claude/skills/tool/huge.bin': 'x',
    },
  });
  const corpus = await discoverInstructionCorpus(
    { repoRoot: '/repo' },
    {
      estimator: fakeEstimator,
      fileSystem: {
        ...fs,
        fileSize: async (root, rel) =>
          rel === '.claude/skills/tool/huge.bin' ? 5 * 1024 * 1024 : fs.fileSize(root, rel),
      },
    },
  );
  assert.ok(corpus.diagnostics.some(
    (d) => d.locator === 'repo:.claude/skills/tool/huge.bin' && /exceeds/.test(d.message),
  ), 'oversized resource read during the merge loop must surface');
});

test('the library imports no check, core, provider, cache, or CLI code', () => {
  const base = join(import.meta.dirname, '..', 'src', 'corpora', 'instructions');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.ts')) files.push(join(dir, entry.name));
    }
  };
  walk(base);
  assert.ok(files.length >= 10);
  const forbidden = [/\/checks\//, /\/core\//, /@anthropic-ai/, /^openai$/, /src\/cli/];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const specifier = match[1]!;
      const allowed =
        specifier.startsWith('node:') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier === 'yaml' ||
        specifier.startsWith('js-tiktoken');
      assert.ok(allowed, `${file} imports ${specifier}`);
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(specifier), `${file} imports forbidden ${specifier}`);
      }
    }
  }
});
