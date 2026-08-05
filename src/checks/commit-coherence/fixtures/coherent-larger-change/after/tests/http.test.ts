import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson } from '../src/http.ts';

test('fetchJson rejects once the retry budget is spent', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('nope', { status: 500 });
  };
  await assert.rejects(() => fetchJson('/api/thing', { attempts: 2, backoffMs: 0 }), /GET \/api\/thing: 500/);
  assert.equal(calls, 2, 'every configured attempt is used before giving up');
});

test('fetchJson recovers when a later attempt succeeds', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3 ? new Response('nope', { status: 503 }) : Response.json({ ok: true });
  };
  const body = await fetchJson('/api/thing', { attempts: 3, backoffMs: 0 });
  assert.deepEqual(body, { ok: true });
});
