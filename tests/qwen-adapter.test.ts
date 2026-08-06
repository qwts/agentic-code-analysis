import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { createQwenJudge } from '../src/core/adapters/qwen.ts';
import { ConfigError } from '../src/core/config.ts';
import { createJudgeClient, JudgeUnavailableError, MissingCredentialsError } from '../src/core/judge-client.ts';

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

function apiError(status: number, code: string, message = code): Error {
  return Object.assign(new Error(message), { status, code });
}

test('qwen adapter preserves the answer budget and adds an equal bounded-thinking budget', async () => {
  const capture: { params?: unknown } = {};
  const judge = createQwenJudge('qwen-model', stub(completion({ content: '{"verdict":"pass"}' }), capture));
  assert.equal(judge.provider, 'qwen');
  assert.deepEqual(await judge.judge(REQUEST), { ok: true, verdict: { verdict: 'pass' } });

  const params = capture.params as Record<string, unknown>;
  assert.equal(params['model'], 'qwen-model');
  assert.equal(params['max_tokens'], 64);
  assert.equal(params['enable_thinking'], true);
  assert.equal(params['thinking_budget'], 64);
  assert.equal('max_completion_tokens' in params, false);
  assert.equal('reasoning_effort' in params, false);
  assert.equal('extra_body' in params, false);
  assert.equal('temperature' in params || 'top_p' in params, false);
  assert.deepEqual(params['response_format'], { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } } });
  assert.deepEqual(params['messages'], [
    { role: 'system', content: 'rule text' },
    { role: 'user', content: 'file payload' },
  ]);
});

test('qwen adapter degrades refusal, truncation, empty, malformed, and transient failures', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [completion({ refusal: 'no' }), /judge refused/],
    [{ choices: [{ finish_reason: 'length', message: { content: '{"tru', refusal: null } }] }, /truncated/],
    [completion({}), /no text content/],
    [completion({ content: 'not json' }), /failed schema parse/],
    [new Error('connection refused'), /api error: connection refused/],
    [{ choices: [] }, /no completion choice/],
  ];
  for (const [response, expected] of cases) {
    const result = await createQwenJudge('m', stub(response)).judge(REQUEST);
    assert.equal(result.ok, false);
    assert.match((result as { note: string }).note, expected);
  }
  const nonError = await createQwenJudge('m', {
    chat: { completions: { create: async () => Promise.reject('socket hang up') } },
  } as never).judge(REQUEST);
  assert.deepEqual(nonError, { ok: false, note: 'api error: socket hang up' });
});

test('qwen account rejection throws only for unambiguous gate-down shapes', async () => {
  for (const status of [401, 402, 403]) {
    await assert.rejects(createQwenJudge('m', stub(apiError(status, 'Rejected'))).judge(REQUEST), JudgeUnavailableError);
  }
  await assert.rejects(createQwenJudge('m', stub(apiError(400, 'Arrearage'))).judge(REQUEST), /qwen judge unavailable/);
  for (const code of ['CommodityNotPurchased', 'PrepaidBillOverdue', 'PostpaidBillOverdue']) {
    await assert.rejects(createQwenJudge('m', stub(apiError(429, code))).judge(REQUEST), JudgeUnavailableError);
  }
});

test('qwen ambiguous quota and throttling errors remain transient', async () => {
  for (const error of [
    apiError(400, 'InvalidParameter'),
    apiError(429, 'insufficient_quota'),
    apiError(429, 'Throttling'),
    apiError(429, ''),
  ]) {
    const result = await createQwenJudge('m', stub(error)).judge(REQUEST);
    assert.deepEqual(result, { ok: false, note: `api error: ${error.message}` });
  }
});

test('qwen requires both API key and base URL without an injected client', () => {
  const saved = { key: process.env['QWEN_API_KEY'], base: process.env['QWEN_BASE_URL'] };
  try {
    delete process.env['QWEN_API_KEY'];
    delete process.env['QWEN_BASE_URL'];
    assert.throws(() => createQwenJudge('m'), MissingCredentialsError);
    process.env['QWEN_API_KEY'] = 'test-key';
    assert.throws(() => createQwenJudge('m'), ConfigError);
    delete process.env['QWEN_API_KEY'];
    process.env['QWEN_BASE_URL'] = 'https://example.invalid/v1';
    assert.throws(() => createQwenJudge('m'), MissingCredentialsError);
  } finally {
    if (saved.key === undefined) delete process.env['QWEN_API_KEY'];
    else process.env['QWEN_API_KEY'] = saved.key;
    if (saved.base === undefined) delete process.env['QWEN_BASE_URL'];
    else process.env['QWEN_BASE_URL'] = saved.base;
  }
});

test('judge client factory recognizes qwen without making a request', async () => {
  const saved = { key: process.env['QWEN_API_KEY'], base: process.env['QWEN_BASE_URL'] };
  process.env['QWEN_API_KEY'] = 'test-key';
  process.env['QWEN_BASE_URL'] = 'https://example.invalid/v1';
  try {
    const judge = await createJudgeClient({ provider: 'qwen', model: 'qwen-model' });
    assert.equal(judge.provider, 'qwen');
    assert.equal(judge.model, 'qwen-model');
  } finally {
    if (saved.key === undefined) delete process.env['QWEN_API_KEY'];
    else process.env['QWEN_API_KEY'] = saved.key;
    if (saved.base === undefined) delete process.env['QWEN_BASE_URL'];
    else process.env['QWEN_BASE_URL'] = saved.base;
  }
});
