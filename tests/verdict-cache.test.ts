import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerdictCache } from '../src/core/verdict-cache.ts';

const COMPONENTS = ['file content', 'import:a.ts,b.ts', 'imported-by:c.ts', 'rule text', 'prompt-v1', 'anthropic', 'model-x'];

test('key is deterministic', () => {
  assert.equal(VerdictCache.key(COMPONENTS), VerdictCache.key([...COMPONENTS]));
});

test('every key component is load-bearing', () => {
  const full = VerdictCache.key(COMPONENTS);
  for (let i = 0; i < COMPONENTS.length; i++) {
    const dropped = COMPONENTS.toSpliced(i, 1);
    assert.notEqual(VerdictCache.key(dropped), full, `dropping component ${i} did not change the key`);
    const mutated = COMPONENTS.with(i, `${COMPONENTS[i]}*`);
    assert.notEqual(VerdictCache.key(mutated), full, `mutating component ${i} did not change the key`);
  }
});

test('component boundaries cannot collide', () => {
  assert.notEqual(VerdictCache.key(['ab', 'c']), VerdictCache.key(['a', 'bc']));
});

test('get/set round-trips and misses are undefined', () => {
  const cache = new VerdictCache(mkdtempSync(join(tmpdir(), 'aca-cache-')), 'test-check');
  const key = VerdictCache.key(COMPONENTS);
  assert.equal(cache.get(key), undefined);
  cache.set(key, { verdict: 'pass', violations: [] });
  assert.deepEqual(cache.get(key), { verdict: 'pass', violations: [] });
});
