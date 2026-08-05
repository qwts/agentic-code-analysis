import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetry } from '../src/retry.ts';

test('withRetry returns the first success without further attempts', async () => {
  let calls = 0;
  const value = await withRetry({ attempts: 3, backoffMs: 0 }, async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries transient failures up to the attempt budget', async () => {
  let calls = 0;
  const value = await withRetry({ attempts: 3, backoffMs: 0 }, async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'recovered';
  });
  assert.equal(value, 'recovered');
  assert.equal(calls, 3);
});

test('withRetry propagates the last error once attempts are spent', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry({ attempts: 2, backoffMs: 0 }, async () => {
        calls += 1;
        throw new Error(`attempt ${calls} failed`);
      }),
    /attempt 2 failed/,
  );
  assert.equal(calls, 2);
});

test('a single-attempt policy never retries', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry({ attempts: 1, backoffMs: 0 }, async () => {
        calls += 1;
        throw new Error('hard failure');
      }),
    /hard failure/,
  );
  assert.equal(calls, 1);
});
