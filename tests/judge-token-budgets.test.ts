import assert from 'node:assert/strict';
import { test } from 'node:test';
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
