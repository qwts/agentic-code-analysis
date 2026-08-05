import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceEstimator } from '../src/check-groups/agent-context/corpus/index.ts';
import { globList, parseFrontmatter } from '../src/check-groups/agent-context/corpus/frontmatter.ts';

test('heuristic-v1: ceil(utf8Bytes/4), exact bytes, estimated marker, estimator id', () => {
  assert.deepEqual(referenceEstimator.estimate(''), { tokens: 0, bytes: 0, estimated: true, estimator: 'heuristic-v1' });
  assert.deepEqual(referenceEstimator.estimate('abcd'), { tokens: 1, bytes: 4, estimated: true, estimator: 'heuristic-v1' });
  assert.equal(referenceEstimator.estimate('abcde').tokens, 2, 'ceil, never floor');
  const unicode = referenceEstimator.estimate('日本語'); // 3 chars, 9 UTF-8 bytes
  assert.equal(unicode.bytes, 9);
  assert.equal(unicode.tokens, 3);
  const crlf = referenceEstimator.estimate('a\r\nb');
  assert.equal(crlf.bytes, 4);
});

test('front matter: scalars, inline lists, dash lists, quotes, comments', () => {
  const parsed = parseFrontmatter('---\nname: deploy\nglobs: ["src/**", "lib/**"]\npaths:\n  - a/**\n  - b/**\n# comment\nquoted: "hello world"\n---\nBody text\n');
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.fields.get('name'), 'deploy');
  assert.deepEqual(parsed.fields.get('globs'), ['src/**', 'lib/**']);
  assert.deepEqual(parsed.fields.get('paths'), ['a/**', 'b/**']);
  assert.equal(parsed.fields.get('quoted'), 'hello world');
  assert.equal(parsed.body, 'Body text\n');
});

test('front matter degrades honestly: absent, unterminated, unsupported forms', () => {
  assert.equal(parseFrontmatter('no front matter\n').error, 'no front matter');
  assert.equal(parseFrontmatter('---\nkey: value\n').error, 'unterminated front matter');
  assert.match(parseFrontmatter('---\nnested:\n  deep: value\n---\nbody\n').error ?? '', /unsupported front matter line/);
});

test('globList accepts inline lists, dash lists, and comma-separated scalars', () => {
  const inline = parseFrontmatter('---\nglobs: [a, b]\n---\n').fields;
  assert.deepEqual(globList(inline, 'globs'), ['a', 'b']);
  const scalar = parseFrontmatter('---\nglobs: src/**, lib/**\n---\n').fields;
  assert.deepEqual(globList(scalar, 'globs'), ['src/**', 'lib/**']);
  assert.equal(globList(scalar, 'missing'), undefined);
});
