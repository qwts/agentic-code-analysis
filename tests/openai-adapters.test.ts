import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { createOpenAiJudge } from '../src/core/adapters/openai.ts';
import { createLocalJudge } from '../src/core/adapters/local.ts';
import { JudgeUnavailableError, MissingCredentialsError } from '../src/core/judge-client.ts';

const REQUEST = { system: 'rule text', user: 'file payload', schema: { type: 'object' }, maxTokens: 64 };

function stub(response: unknown, capture?: { params?: unknown }): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: unknown) => {
          if (capture) capture.params = params;
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
  } as unknown as OpenAI;
}

function completion(overrides: Record<string, unknown>): unknown {
  return { choices: [{ finish_reason: 'stop', message: { content: null, refusal: null, ...overrides } }] };
}

test('openai adapter: strict json_schema params, max_completion_tokens, no sampling knobs', async () => {
  const capture: { params?: unknown } = {};
  const judge = createOpenAiJudge('model-x', stub(completion({ content: '{"verdict":"pass"}' }), capture));
  assert.equal(judge.provider, 'openai');
  assert.deepEqual(await judge.judge(REQUEST), { ok: true, verdict: { verdict: 'pass' } });
  const params = capture.params as Record<string, unknown>;
  assert.equal(params['model'], 'model-x');
  assert.equal(params['max_completion_tokens'], 64);
  assert.equal('max_tokens' in params, false);
  assert.equal('enable_thinking' in params || 'thinking_budget' in params, false);
  assert.deepEqual(params['response_format'], { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } } });
  assert.deepEqual(params['messages'], [
    { role: 'system', content: 'rule text' },
    { role: 'user', content: 'file payload' },
  ]);
  assert.equal('temperature' in params || 'top_p' in params, false);
});

test('local adapter: max_tokens for wide server compatibility', async () => {
  const capture: { params?: unknown } = {};
  const judge = createLocalJudge('local-model', stub(completion({ content: '{"verdict":"pass"}' }), capture));
  assert.equal(judge.provider, 'local');
  await judge.judge(REQUEST);
  const params = capture.params as Record<string, unknown>;
  assert.equal(params['max_tokens'], 64);
  assert.equal('max_completion_tokens' in params, false);
  assert.equal('enable_thinking' in params || 'thinking_budget' in params, false);
});

test('degrade paths: refusal, truncation, empty, unparseable, api error', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [completion({ refusal: 'no' }), /judge refused/],
    [{ choices: [{ finish_reason: 'length', message: { content: '{"tru', refusal: null } }] }, /truncated/],
    [completion({}), /no text content/],
    [completion({ content: 'not json' }), /failed schema parse/],
    [new Error('connection refused'), /api error: connection refused/],
    [{ choices: [] }, /no completion choice/],
  ];
  const nonError = await createOpenAiJudge('m', {
    chat: { completions: { create: async () => Promise.reject('socket hang up') } },
  } as never).judge(REQUEST);
  assert.deepEqual(nonError, { ok: false, note: 'api error: socket hang up' });
  for (const [response, expected] of cases) {
    const result = await createOpenAiJudge('m', stub(response)).judge(REQUEST);
    assert.equal(result.ok, false);
    assert.match((result as { note: string }).note, expected);
  }
});

test('account rejection throws JudgeUnavailableError: 401/402/403, and the 429 insufficient_quota shape', async () => {
  for (const status of [401, 402, 403]) {
    await assert.rejects(createOpenAiJudge('m', stub(Object.assign(new Error('rejected'), { status }))).judge(REQUEST), JudgeUnavailableError);
  }
  // OpenAI reports a depleted account as 429 insufficient_quota, not 402
  // (issue #11); the local adapter shares the transport, so a 402 from an
  // OpenAI-compatible router (e.g. HF) takes the same path.
  const depleted = Object.assign(new Error('quota exhausted'), { status: 429, code: 'insufficient_quota' });
  await assert.rejects(createOpenAiJudge('m', stub(depleted)).judge(REQUEST), /openai judge unavailable — quota exhausted/);
  await assert.rejects(createLocalJudge('m', stub(Object.assign(new Error('402'), { status: 402 }))).judge(REQUEST), /local judge unavailable/);
});

test('a plain 429 is rate limiting, not a dead gate — degrades to not-ok', async () => {
  const result = await createOpenAiJudge('m', stub(Object.assign(new Error('slow down'), { status: 429 }))).judge(REQUEST);
  assert.deepEqual(result, { ok: false, note: 'api error: slow down' });
});

test('openai adapter throws MissingCredentialsError without credentials, including admin-only', () => {
  const saved = { api: process.env['OPENAI_API_KEY'], admin: process.env['OPENAI_ADMIN_KEY'] };
  delete process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_ADMIN_KEY'];
  try {
    assert.throws(() => createOpenAiJudge('model-x'), MissingCredentialsError);
    // Admin keys satisfy the constructor but cannot call chat.completions.
    process.env['OPENAI_ADMIN_KEY'] = 'sk-admin-test';
    assert.throws(() => createOpenAiJudge('model-x'), MissingCredentialsError);
  } finally {
    delete process.env['OPENAI_ADMIN_KEY'];
    if (saved.api !== undefined) process.env['OPENAI_API_KEY'] = saved.api;
    if (saved.admin !== undefined) process.env['OPENAI_ADMIN_KEY'] = saved.admin;
  }
});

test('local adapter needs no credentials and honors ACA_LOCAL_BASE_URL', () => {
  const saved = process.env['ACA_LOCAL_BASE_URL'];
  process.env['ACA_LOCAL_BASE_URL'] = 'http://localhost:9999/v1';
  try {
    assert.equal(createLocalJudge('m').provider, 'local');
  } finally {
    if (saved === undefined) delete process.env['ACA_LOCAL_BASE_URL'];
    else process.env['ACA_LOCAL_BASE_URL'] = saved;
  }
});
