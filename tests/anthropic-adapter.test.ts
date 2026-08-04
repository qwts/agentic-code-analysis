import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicJudge } from '../src/core/adapters/anthropic.ts';

const REQUEST = { system: 'rule text', user: 'file payload', schema: { type: 'object' }, maxTokens: 64 };

function stub(response: unknown, capture?: { params?: unknown }): Anthropic {
  return {
    messages: {
      create: async (params: unknown) => {
        if (capture) capture.params = params;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  } as unknown as Anthropic;
}

function message(overrides: Record<string, unknown>): unknown {
  return { stop_reason: 'end_turn', stop_details: null, content: [], ...overrides };
}

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
