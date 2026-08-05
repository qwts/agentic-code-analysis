import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangeIndex, Referent } from '../src/checks/doc-drift/change-index.ts';
import { buildEvidence, MAX_EVIDENCE_BYTES, MAX_REFERENTS } from '../src/checks/doc-drift/evidence.ts';
import { extractReferences } from '../src/checks/doc-drift/references.ts';

function index(entries: [string, Referent][]): ChangeIndex {
  return new Map(entries);
}

test('path references intersect by resolved path; token references by head or base text', () => {
  const refs = extractReferences('docs/x.md', 'See [a](../src/a.ts); `oldSymbol` was the entry; run `aca --json`.');
  const bundle = buildEvidence(
    refs,
    index([
      ['src/a.ts', { path: 'src/a.ts', status: 'modified', head: 'export const a = 1;\n', base: 'export const a = 0;\n' }],
      ['src/b.ts', { path: 'src/b.ts', status: 'deleted', base: 'export function oldSymbol() {}\n' }],
      ['src/c.ts', { path: 'src/c.ts', status: 'modified', head: 'unrelated\n', base: 'unrelated\n' }],
    ]),
  );
  assert.deepEqual(
    bundle.references.map((r) => [r.id, r.kind, r.literal, r.referentPath]),
    [
      ['r1', 'path', '../src/a.ts', 'src/a.ts'],
      ['r2', 'symbol', 'oldSymbol', 'src/b.ts'],
    ],
  );
  assert.deepEqual(
    bundle.referents.map((r) => [r.path, r.status, r.content !== undefined]),
    [
      ['src/a.ts', 'modified', true],
      ['src/b.ts', 'deleted', false],
    ],
  );
});

test('a doc whose references touch no changed referent yields an empty bundle (zero judge calls)', () => {
  const refs = extractReferences('README.md', '[x](src/unchanged.ts) and `someSymbol`');
  const bundle = buildEvidence(refs, index([['src/other.ts', { path: 'src/other.ts', status: 'modified', head: 'nothing here\n' }]]));
  assert.deepEqual(bundle.references, []);
  assert.deepEqual(bundle.referents, []);
  assert.equal(bundle.overflow, undefined);
});

test('records deduplicate per (kind, literal, referent) and ids are stable ordinals over the sorted set', () => {
  const refs = extractReferences('docs/x.md', '`shared` here and `shared` there; [z](../src/z.ts) and `src/z.ts`.');
  const bundle = buildEvidence(
    refs,
    index([['src/z.ts', { path: 'src/z.ts', status: 'modified', head: 'const shared = 1;\n' }]]),
  );
  // Two distinct path literals resolve to the same referent; the symbol collapses to one.
  assert.deepEqual(
    bundle.references.map((r) => [r.id, r.kind, r.literal]),
    [
      ['r1', 'path', '../src/z.ts'],
      ['r2', 'path', 'src/z.ts'],
      ['r3', 'symbol', 'shared'],
    ],
  );
});

test('referent and byte caps overflow explicitly, never silently truncate', () => {
  const many = Array.from({ length: MAX_REFERENTS + 1 }, (_, i) => `src/f${i}.ts`);
  const refs = extractReferences('README.md', many.map((p) => `[x${p}](${p})`).join(' '));
  const over = buildEvidence(refs, index(many.map((p) => [p, { path: p, status: 'modified' as const, head: 'x\n' }])));
  assert.match(over.overflow!, /exceed the cap/);

  const bigRefs = extractReferences('README.md', '[big](src/big.ts)');
  const big = buildEvidence(
    bigRefs,
    index([['src/big.ts', { path: 'src/big.ts', status: 'modified', head: 'a'.repeat(MAX_EVIDENCE_BYTES + 1) }]]),
  );
  assert.match(big.overflow!, /bytes of referent evidence/);
});

test('an unreadable-but-present referent is reported, never conflated with deleted', () => {
  const refs = extractReferences('README.md', '[u](src/u.ts)');
  const bundle = buildEvidence(refs, index([['src/u.ts', { path: 'src/u.ts', status: 'seeded', unreadable: true }]]));
  assert.deepEqual(bundle.unreadable, ['src/u.ts']);
  assert.equal(bundle.referents[0]!.status, 'seeded');
});
