import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstructionCorpus, snapshotFromMap, walkTree } from '../src/check-groups/agent-context/corpus/index.ts';

const snap = (files: Record<string, string>) => snapshotFromMap(new Map(Object.entries(files)));
const corpusOf = (files: Record<string, string>) => buildInstructionCorpus({ repoRoot: '(injected)', repoSnapshot: snap(files) });

test('AGENTS.md is one source with one binding per documented consumer', () => {
  const corpus = corpusOf({ 'AGENTS.md': '# rules\n' });
  assert.equal(corpus.sources.length, 1);
  const source = corpus.sources[0]!;
  assert.equal(source.id, 'repo:AGENTS.md');
  assert.deepEqual(
    source.bindings.map((b) => b.tool),
    ['codex', 'cursor', 'windsurf'],
  );
  assert.ok(source.bindings.every((b) => b.semantics.status === 'verified' && b.activation === 'always'));
});

test('claude memory: root files are always, nested CLAUDE.md is path-scoped', () => {
  const corpus = corpusOf({
    'CLAUDE.md': 'root memory\n',
    '.claude/CLAUDE.md': 'alt root memory\n',
    'packages/api/CLAUDE.md': 'api memory\n',
  });
  const byPath = new Map(corpus.sources.map((s) => [s.path, s]));
  assert.equal(byPath.get('CLAUDE.md')!.bindings[0]!.activation, 'always');
  assert.equal(byPath.get('.claude/CLAUDE.md')!.bindings[0]!.scopeDir, '');
  const nested = byPath.get('packages/api/CLAUDE.md')!.bindings[0]!;
  assert.equal(nested.activation, 'path');
  assert.equal(nested.scopeDir, 'packages/api');
});

test('claude @imports expand inside the root, escape and missing become diagnostics', () => {
  const corpus = corpusOf({
    'CLAUDE.md': 'see @docs/conventions.md and @../outside.md and @docs/missing.md\n',
    'docs/conventions.md': 'imported text\n',
  });
  const memory = corpus.sources.find((s) => s.path === 'CLAUDE.md')!;
  const fragments = memory.bindings[0]!.fragments;
  assert.equal(fragments.filter((f) => f.kind === 'import').length, 1);
  assert.equal(fragments.find((f) => f.kind === 'import')!.text, 'imported text\n');
  assert.ok(memory.diagnostics.some((d) => d.includes('escapes authorized root')));
  assert.ok(memory.diagnostics.some((d) => d.includes('not found in authorized root')));
});

test('skills split routing metadata (always) from body (model-selected); commands are manual', () => {
  const corpus = corpusOf({
    '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship it safely\n---\nLong body here.\n',
    '.claude/commands/release.md': 'Release steps.\n',
  });
  const skill = corpus.sources.find((s) => s.path.endsWith('SKILL.md'))!.bindings[0]!;
  assert.deepEqual(
    skill.fragments.map((f) => [f.kind, f.activation]),
    [
      ['metadata', 'always'],
      ['body', 'model-selected'],
    ],
  );
  assert.equal(skill.fragments[0]!.text, 'deploy: Ship it safely');
  const command = corpus.sources.find((s) => s.path.endsWith('release.md'))!.bindings[0]!;
  assert.equal(command.activation, 'manual');
});

test('a malformed skill front matter degrades to unverified/unknown, never a guess', () => {
  const corpus = corpusOf({ '.claude/skills/broken/SKILL.md': '---\nname: [nested: {bad\n---\nbody\n' });
  const binding = corpus.sources[0]!.bindings[0]!;
  assert.equal(binding.semantics.status, 'unverified');
  assert.equal(binding.activation, 'unknown');
});

test('cursor rule activation follows front matter; legacy .cursorrules stays unverified', () => {
  const corpus = corpusOf({
    '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\nAlways rule\n',
    '.cursor/rules/scoped.mdc': '---\nglobs: ["src/**/*.ts"]\n---\nScoped rule\n',
    '.cursor/rules/routed.mdc': '---\ndescription: Use for database work\n---\nRouted rule\n',
    '.cursor/rules/manual.mdc': 'Manual rule\n',
    'packages/web/.cursor/rules/web.mdc': '---\nalwaysApply: true\n---\nWeb rule\n',
    '.cursorrules': 'legacy content\n',
  });
  const activation = (path: string) => corpus.sources.find((s) => s.path === path)!.bindings[0]!;
  assert.equal(activation('.cursor/rules/always.mdc').activation, 'always');
  assert.deepEqual(activation('.cursor/rules/scoped.mdc').pathGlobs, ['src/**/*.ts']);
  assert.equal(activation('.cursor/rules/routed.mdc').activation, 'model-selected');
  assert.equal(activation('.cursor/rules/manual.mdc').activation, 'manual');
  assert.equal(activation('packages/web/.cursor/rules/web.mdc').scopeDir, 'packages/web');
  const legacy = activation('.cursorrules');
  assert.equal(legacy.semantics.status, 'unverified');
  assert.equal(legacy.activation, 'unknown');
});

test('copilot: repo instructions always; path instructions need applyTo; windsurf triggers map', () => {
  const corpus = corpusOf({
    '.github/copilot-instructions.md': 'repo-wide\n',
    '.github/instructions/api.instructions.md': '---\napplyTo: "src/api/**"\n---\nAPI guidance\n',
    '.github/instructions/bare.instructions.md': 'no front matter\n',
    '.windsurf/rules/main.md': '---\ntrigger: always_on\n---\nWindsurf rule\n',
    '.windsurfrules': 'legacy windsurf\n',
  });
  const binding = (path: string) => corpus.sources.find((s) => s.path === path)!.bindings[0]!;
  assert.equal(binding('.github/copilot-instructions.md').activation, 'always');
  assert.deepEqual(binding('.github/instructions/api.instructions.md').pathGlobs, ['src/api/**']);
  assert.equal(binding('.github/instructions/bare.instructions.md').semantics.status, 'unverified');
  assert.equal(binding('.windsurf/rules/main.md').activation, 'always');
  assert.equal(binding('.windsurfrules').semantics.status, 'unverified');
});

test('a user-origin root uses the ~/.claude layout: bare CLAUDE.md, skills/, commands/', () => {
  const corpus = buildInstructionCorpus({
    repoRoot: '(injected)',
    repoSnapshot: snap({}),
    userRoots: [
      {
        label: 'claude-user',
        snapshot: snap({
          'CLAUDE.md': 'user memory\n',
          'skills/notes/SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nbody\n',
          'commands/tidy.md': 'tidy\n',
        }),
      },
    ],
  });
  const ids = corpus.sources.map((s) => s.id);
  assert.deepEqual(ids, ['user:claude-user/CLAUDE.md', 'user:claude-user/commands/tidy.md', 'user:claude-user/skills/notes/SKILL.md']);
});

test('output is deterministic: sorted sources, stable ids, identical across builds', () => {
  const files = {
    'b/AGENTS.md': 'b\n',
    'AGENTS.md': 'root\n',
    'CLAUDE.md': 'memory\n',
  };
  const one = corpusOf(files);
  const two = corpusOf(files);
  assert.deepEqual(one, two);
  assert.deepEqual(
    one.sources.map((s) => s.id),
    ['repo:AGENTS.md', 'repo:CLAUDE.md', 'repo:b/AGENTS.md'],
  );
});

test('the corpus package imports no judge, check, cache, CLI, or provider code', () => {
  const root = join(import.meta.dirname, '..', 'src', 'check-groups', 'agent-context', 'corpus');
  const forbidden = [/core\/judge-client/, /core\/verdict-cache/, /core\/adapters/, /\/checks\//, /cli\.ts/, /@anthropic/, /from 'openai'/];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  for (const file of walk(root)) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.ok(!pattern.test(content), `${file} matches ${pattern}`);
  }
});

test('walkTree prunes vcs/dependency trees, flags symlink escapes and binary files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aca-corpus-'));
  const outside = mkdtempSync(join(tmpdir(), 'aca-outside-'));
  try {
    writeFileSync(join(outside, 'secret.md'), 'outside\n');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'AGENTS.md'), 'pruned\n');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'AGENTS.md'), 'pruned\n');
    writeFileSync(join(dir, 'AGENTS.md'), 'real\n');
    writeFileSync(join(dir, 'binary.md'), Buffer.from([0x23, 0x00, 0xff]));
    symlinkSync(join(outside, 'secret.md'), join(dir, 'escape.md'));
    const snapshot = walkTree(dir);
    assert.deepEqual(snapshot.paths, ['AGENTS.md', 'binary.md']);
    assert.equal(snapshot.content('AGENTS.md'), 'real\n');
    assert.equal(snapshot.content('binary.md'), undefined);
    assert.ok(snapshot.diagnostics.some((d) => d.includes('symlink escapes root')));
    assert.ok(snapshot.diagnostics.some((d) => d.includes('binary content')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
