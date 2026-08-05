import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractReferences, tokenMatches, type RawReference } from '../src/checks/doc-drift/references.ts';

const byKind = (refs: RawReference[], kind: RawReference['kind']) => refs.filter((r) => r.kind === kind);

test('link destinations resolve relative to the document, anchors stripped', () => {
  const refs = extractReferences('docs/guide.md', 'See [backoff](../src/retry/backoff.ts#L10) and [design](design/suite.md).');
  assert.deepEqual(
    byKind(refs, 'path').map((r) => r.resolvedPath),
    ['src/retry/backoff.ts', 'docs/design/suite.md'],
  );
});

test('schemes, absolute paths, bare anchors, and traversal outside the repo are rejected', () => {
  const refs = extractReferences(
    'README.md',
    '[a](https://example.com/x.md) [b](mailto:x@y.z) [c](/etc/passwd) [d](#section) [e](../outside.md) [f](./ok.md)',
  );
  assert.deepEqual(
    byKind(refs, 'path').map((r) => r.resolvedPath),
    ['ok.md'],
  );
});

test('inline code yields path literals (repo-relative), symbols, flags, and command words', () => {
  const refs = extractReferences(
    'docs/cli.md',
    'Run `aca doc-drift --json` after editing `src/cli.ts`; `resolveTier` reads `--base` too. Short tokens like `ab` are ignored.',
  );
  assert.deepEqual(byKind(refs, 'path').map((r) => r.resolvedPath), ['src/cli.ts']);
  assert.deepEqual(byKind(refs, 'symbol').map((r) => r.literal), ['resolveTier']);
  assert.deepEqual(byKind(refs, 'flag').map((r) => r.literal).sort(), ['--base', '--json']);
  assert.deepEqual(byKind(refs, 'command').map((r) => r.literal), ['aca', 'doc-drift']);
});

test('shell fences yield commands, flags, and paths; prompts and comments are stripped', () => {
  const doc = ['```sh', '# comment lines are skipped', '$ retry-cli --attempts 3 -- src/tool.ts', '```'].join('\n');
  const refs = extractReferences('docs/x.md', doc);
  assert.deepEqual(byKind(refs, 'command').map((r) => r.literal), ['retry-cli']);
  assert.deepEqual(byKind(refs, 'flag').map((r) => r.literal), ['--attempts']);
  assert.deepEqual(byKind(refs, 'path').map((r) => r.resolvedPath), ['src/tool.ts']);
});

test('non-shell fences yield paths and flags but never commands or symbols', () => {
  const doc = ['```ts', "import { judge } from './src/core/judge-client.ts';", 'run(--enforce);', '```'].join('\n');
  const refs = extractReferences('README.md', doc);
  assert.deepEqual(byKind(refs, 'command'), []);
  assert.deepEqual(byKind(refs, 'symbol'), []);
  assert.deepEqual(byKind(refs, 'flag').map((r) => r.literal), ['--enforce']);
  assert.ok(byKind(refs, 'path').some((r) => r.resolvedPath === 'src/core/judge-client.ts'));
});

test('duplicates collapse to the first occurrence with its line', () => {
  const refs = extractReferences('README.md', '`withRetry` first\n\n`withRetry` again');
  assert.equal(byKind(refs, 'symbol').length, 1);
  assert.equal(refs[0]!.line, 1);
});

test('line attribution is 1-indexed per occurrence', () => {
  const refs = extractReferences('README.md', 'intro\n\nsee [x](src/x.ts)\n');
  assert.equal(byKind(refs, 'path')[0]!.line, 3);
});

test('tokenMatches requires word boundaries per kind', () => {
  assert.ok(tokenMatches('const DEFAULT_RETRIES = 5;', 'symbol', 'DEFAULT_RETRIES'));
  assert.ok(!tokenMatches('const DEFAULT_RETRIES_MAX = 9;', 'symbol', 'DEFAULT_RETRIES'));
  assert.ok(tokenMatches("if (arg === '--attempts')", 'flag', '--attempts'));
  assert.ok(!tokenMatches("if (arg === '--attempts-max')", 'flag', '--attempts'));
  assert.ok(!tokenMatches('reattempts', 'flag', '--attempts'));
  assert.ok(tokenMatches('usage: retry-cli [--attempts]', 'command', 'retry-cli'));
});
