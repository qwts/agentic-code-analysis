import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicJudge } from '../src/core/adapters/anthropic.ts';
import { JudgeUnavailableError, MissingCredentialsError } from '../src/core/judge-client.ts';

const REQUEST = { system: 'rule text', user: 'file payload', schema: { type: 'object' }, maxTokens: 64 };

function stub(response: unknown, capture?: { params?: unknown }): Anthropic {
  // The adapter streams (the 32k budget trips the SDK's non-streaming
  // 10-minute guard) and consumes the reassembled final message, so the stub
  // models exactly that surface: stream(params) -> { finalMessage() }.
  return {
    messages: {
      stream: (params: unknown) => {
        if (capture) capture.params = params;
        return {
          finalMessage: async () => {
            if (response instanceof Error) throw response;
            return response;
          },
        };
      },
    },
  } as unknown as Anthropic;
}

function message(overrides: Record<string, unknown>): unknown {
  return { stop_reason: 'end_turn', stop_details: null, content: [], ...overrides };
}

test('missing credentials throw at creation, not at first request', () => {
  // The SDK constructs fine with null credentials (review finding, PR #7);
  // the adapter must surface the miss when the client is created.
  const saved = { key: process.env['ANTHROPIC_API_KEY'], token: process.env['ANTHROPIC_AUTH_TOKEN'] };
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  try {
    assert.throws(() => createAnthropicJudge('model-x'), MissingCredentialsError);
  } finally {
    if (saved.key !== undefined) process.env['ANTHROPIC_API_KEY'] = saved.key;
    if (saved.token !== undefined) process.env['ANTHROPIC_AUTH_TOKEN'] = saved.token;
  }
});

test('valid structured output returns the parsed verdict', async () => {
  const capture: { params?: unknown } = {};
  const judge = createAnthropicJudge('model-x', stub(message({ content: [{ type: 'text', text: '{"verdict":"pass"}' }] }), capture));
  assert.deepEqual(await judge.judge(REQUEST), { ok: true, verdict: { verdict: 'pass' } });
  const params = capture.params as Record<string, unknown>;
  assert.equal(params['model'], 'model-x');
  assert.equal(params['max_tokens'], 64);
  assert.deepEqual(params['system'], [{ type: 'text', text: 'rule text', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(params['output_config'], { format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal('temperature' in params || 'top_p' in params || 'fallbacks' in params, false);
});

test('refusal degrades to not-ok with the category', async () => {
  const judge = createAnthropicJudge('model-x', stub(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })));
  assert.deepEqual(await judge.judge(REQUEST), { ok: false, note: 'judge refused (cyber)' });
});

test('truncation degrades to not-ok', async () => {
  const judge = createAnthropicJudge('model-x', stub(message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"tru' }] })));
  assert.equal((await judge.judge(REQUEST)).ok, false);
});

test('unparseable output degrades to not-ok', async () => {
  const judge = createAnthropicJudge('model-x', stub(message({ content: [{ type: 'text', text: 'not json' }] })));
  assert.deepEqual(await judge.judge(REQUEST), { ok: false, note: 'judge output failed schema parse' });
});

test('api errors degrade to not-ok, never throw', async () => {
  const judge = createAnthropicJudge('model-x', stub(new Error('overloaded')));
  assert.deepEqual(await judge.judge(REQUEST), { ok: false, note: 'api error: overloaded' });
});

const apiError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

test('account rejection throws JudgeUnavailableError: 401/402/403, and the 400 depleted-credits shape', async () => {
  for (const status of [401, 402, 403]) {
    await assert.rejects(createAnthropicJudge('model-x', stub(apiError(status, 'rejected'))).judge(REQUEST), JudgeUnavailableError);
  }
  // Anthropic reports a depleted account as 400, not 402 (issue #11).
  const depleted = apiError(400, 'Your credit balance is too low to access the Anthropic API.');
  await assert.rejects(createAnthropicJudge('model-x', stub(depleted)).judge(REQUEST), /anthropic judge unavailable — Your credit balance is too low/);
});

test('transient statuses — rate limit, server error, other 400s — still degrade to not-ok', async () => {
  for (const status of [400, 408, 429, 500, 529]) {
    const result = await createAnthropicJudge('model-x', stub(apiError(status, 'transient'))).judge(REQUEST);
    assert.deepEqual(result, { ok: false, note: 'api error: transient' });
  }
});
