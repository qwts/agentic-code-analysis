import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checks } from '../src/checks/registry.ts';

// ACA-0070: one bound for every check and every route. A new check that
// quietly keeps the old 4096 would truncate reasoning models on wires that
// charge hidden reasoning to the answer allowance, and the failure looks like
// a bad judge rather than a small budget.
const SUITE_BOUND = 32_768;

test('every registered check requests the suite-wide judge token budget', async () => {
  const names = [...checks.keys()];
  assert.ok(names.length >= 12, 'the registry must be non-trivial for this to prove anything');
  for (const name of names) {
    const module = (await import(`../src/checks/${name}/judge-io.ts`)) as { MAX_TOKENS?: unknown };
    assert.equal(typeof module.MAX_TOKENS, 'number', `${name} must export a MAX_TOKENS budget`);
    assert.equal(module.MAX_TOKENS, SUITE_BOUND, `${name} must request the ACA-0070 bound`);
  }
});

// The budget is part of the inference profile, not just an output ceiling: on
// a wire that derives hidden reasoning from it (Qwen's `thinking_budget`), a
// verdict cached under a smaller bound was produced by a judge that was
// allowed to think less. Codex caught this on PR #73 — without the bound in
// the key, such an entry silently survives a budget change.
test('every check carries the token bound in its verdict cache identity', () => {
  for (const name of checks.keys()) {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'checks', name, 'index.ts'), 'utf8');
    const start = source.indexOf('VerdictCache.key([');
    assert.notEqual(start, -1, `${name} must build its cache key through VerdictCache.key`);
    const composition = source.slice(start, source.indexOf(']', start));
    assert.match(composition, /MAX_TOKENS/, `${name} must include the token bound in its cache key`);
  }
});
