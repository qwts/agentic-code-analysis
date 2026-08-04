// Anthropic adapter for the JudgeClient port. Contract (ACA-0003 D2): strict
// JSON-schema structured output, refusal/truncation/parse failure degrade to
// {ok: false} — never a crash, never a silent pass — prompt-prefix caching on
// the system block, no sampling knobs. Deliberately no server-side fallbacks:
// a substituted judge model would break the cache key's model attribution.
import Anthropic from '@anthropic-ai/sdk';
import { MissingCredentialsError, type JudgeClient, type JudgeRequest, type JudgeResult } from '../judge-client.ts';

export function createAnthropicJudge(model: string, client?: Anthropic): JudgeClient {
  let anthropic: Anthropic;
  if (client) {
    anthropic = client;
  } else {
    // The SDK constructs with null credentials and errors only on the first
    // request; the exit-code contract (D3) needs the miss at creation time.
    anthropic = new Anthropic();
    if (anthropic.apiKey === null && anthropic.authToken === null) {
      throw new MissingCredentialsError('anthropic');
    }
  }
  return {
    provider: 'anthropic',
    model,
    judge: (request) => judge(anthropic, model, request),
  };
}

async function judge(anthropic: Anthropic, model: string, request: JudgeRequest): Promise<JudgeResult> {
  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: request.schema } },
      messages: [{ role: 'user', content: request.user }],
    });
  } catch (err) {
    return { ok: false, note: `api error: ${(err as Error).message}` };
  }
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    return { ok: false, note: `judge refused${category ? ` (${category})` : ''}` };
  }
  if (response.stop_reason === 'max_tokens') {
    return { ok: false, note: 'judge output truncated at max_tokens' };
  }
  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) {
    return { ok: false, note: `no text content (stop_reason: ${response.stop_reason})` };
  }
  try {
    return { ok: true, verdict: JSON.parse(text) };
  } catch {
    return { ok: false, note: 'judge output failed schema parse' };
  }
}
