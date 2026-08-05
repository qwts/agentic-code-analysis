// Anthropic adapter for the JudgeClient port. Contract (ACA-0003 D2): strict
// JSON-schema structured output, refusal/truncation/parse failure degrade to
// {ok: false} — never a crash, never a silent pass — prompt-prefix caching on
// the system block, no sampling knobs. Account rejection at judge time throws
// instead of degrading (ACA-0011). Deliberately no server-side fallbacks:
// a substituted judge model would break the cache key's model attribution.
import Anthropic from '@anthropic-ai/sdk';
import { GATE_DOWN_STATUSES, JudgeUnavailableError, MissingCredentialsError, type JudgeClient, type JudgeRequest, type JudgeResult } from '../judge-client.ts';

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
    // Non-Error throws must still yield an informative note (review, PR #9).
    const message = err instanceof Error ? err.message : String(err);
    // Duck-typed: SDK APIErrors and proxy throws both carry a numeric status.
    // Anthropic reports a depleted account as 400 invalid_request_error, not
    // 402; other 400s are per-request and stay transient.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && (GATE_DOWN_STATUSES.has(status) || (status === 400 && /credit balance is too low/i.test(message)))) {
      throw new JudgeUnavailableError('anthropic', message);
    }
    return { ok: false, note: `api error: ${message}` };
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
