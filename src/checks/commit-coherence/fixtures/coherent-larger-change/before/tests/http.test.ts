import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson } from '../src/http.ts';

test('fetchJson rejects on a non-ok response', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  await assert.rejects(() => fetchJson('/api/thing'), /GET \/api\/thing: 500/);
});
