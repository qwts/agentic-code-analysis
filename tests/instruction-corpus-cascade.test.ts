import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstructionCorpus, loadSetsForDir, loadSetsUnder, snapshotFromMap, type TokenEstimator } from '../src/check-groups/agent-context/corpus/index.ts';

// Injected fake estimator (1 token per character) so cascade goldens cannot
// be rewritten by an estimator change; the default is tested separately.
const fake: TokenEstimator = {
  id: 'fake-chars',
  estimate: (text) => ({ tokens: text.length, bytes: Buffer.byteLength(text, 'utf8'), estimated: true, estimator: 'fake-chars' }),
};

const corpusOf = (files: Record<string, string>) =>
  buildInstructionCorpus({ repoRoot: '(injected)', repoSnapshot: snapshotFromMap(new Map(Object.entries(files))), estimator: fake });

test('one load-set equivalence class per directory where scope changes, ordered root→leaf', () => {
  const corpus = corpusOf({
    'AGENTS.md': 'root\n',
    'packages/api/AGENTS.md': 'api\n',
  });
  const codex = corpus.loadSets.filter((set) => set.tool === 'codex');
  assert.deepEqual(
    codex.map((set) => set.id),
    ['codex:.', 'codex:packages/api'],
  );
  const nested = codex[1]!;
  assert.deepEqual(
    nested.entries.map((entry) => entry.sourceId),
    ['repo:AGENTS.md', 'repo:packages/api/AGENTS.md'],
    'root loads before the nested override',
  );
  // 'root\n' = 5 chars + 'api\n' = 4 chars, both always+verified.
  assert.equal(nested.baselineTokens, 9);
  assert.equal(corpus.loadSets.find((set) => set.id === 'codex:.')!.baselineTokens, 5);
});

test('baseline counts only verified always fragments; conditional and manual stay separate', () => {
  const corpus = corpusOf({
    'CLAUDE.md': '12345\n', // 6 chars, always
    'packages/api/CLAUDE.md': '123\n', // 4 chars, path-scoped
    '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: dd\n---\nBODY\n', // metadata "x: dd" = 5 always, body model-selected
    '.claude/commands/go.md': 'run\n', // 4 chars, manual
    '.cursorrules': 'legacy!\n', // unverified → conditional, incomplete
  });
  const claudeRoot = corpus.loadSets.find((set) => set.id === 'claude-code:.')!;
  assert.equal(claudeRoot.baselineTokens, 6 + 5, 'root memory + skill metadata');
  assert.equal(claudeRoot.manualTokens, 4);
  assert.ok(claudeRoot.complete, 'claude sets carry only verified bindings');
  const claudeNested = corpus.loadSets.find((set) => set.id === 'claude-code:packages/api')!;
  assert.equal(claudeNested.baselineTokens, claudeRoot.baselineTokens, 'nested memory is conditional, not baseline');
  assert.equal(claudeNested.conditionalTokens - claudeRoot.conditionalTokens, 4);
  const cursor = corpus.loadSets.find((set) => set.id === 'cursor:.')!;
  assert.equal(cursor.complete, false, 'an unverified binding marks the set incomplete');
  assert.equal(cursor.baselineTokens, 0);
  assert.equal(cursor.conditionalTokens, 8);
});

test('a shared physical file is charged once per load set, not once per binding', () => {
  const corpus = corpusOf({ 'AGENTS.md': 'shared\n' }); // 7 chars, 3 tool bindings
  for (const tool of ['codex', 'cursor', 'windsurf']) {
    const set = corpus.loadSets.find((s) => s.id === `${tool}:.`)!;
    assert.equal(set.entries.length, 1);
    assert.equal(set.baselineTokens, 7);
  }
});

test('loadSetsForDir picks the deepest class per tool; loadSetsUnder unions the subtree', () => {
  const corpus = corpusOf({
    'AGENTS.md': 'root\n',
    'packages/api/AGENTS.md': 'api\n',
    'CLAUDE.md': 'memory\n',
  });
  const atApi = loadSetsForDir(corpus, 'packages/api/src');
  assert.deepEqual(
    atApi.map((set) => set.id),
    ['claude-code:.', 'codex:packages/api', 'cursor:packages/api', 'windsurf:packages/api'],
  );
  const atRoot = loadSetsForDir(corpus, '');
  assert.ok(atRoot.every((set) => set.targetDir === ''));
  const under = loadSetsUnder(corpus, '');
  assert.equal(under.length, corpus.loadSets.length, "'' selects every class");
  const underApi = loadSetsUnder(corpus, 'packages/api');
  assert.ok(underApi.some((set) => set.id === 'codex:packages/api'));
  assert.ok(underApi.some((set) => set.id === 'claude-code:.'), 'ancestor classes apply to files directly in the dir');
});

test('load-set identity is independent of enumeration order', () => {
  const a = corpusOf({ 'AGENTS.md': 'x\n', 'packages/api/AGENTS.md': 'y\n' });
  const b = corpusOf({ 'packages/api/AGENTS.md': 'y\n', 'AGENTS.md': 'x\n' });
  assert.deepEqual(a.loadSets, b.loadSets);
});
