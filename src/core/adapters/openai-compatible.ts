// Shared OpenAI-wire transport for the JudgeClient port: chat.completions
// with a strict json_schema response_format — the common denominator that
// OpenAI and OpenAI-compatible local servers (LM Studio, Ollama) both speak.
// Same contract as every adapter (ACA-0003 D2): degrade to {ok:false}, never
// crash, never silently pass; no sampling knobs; prompt caching is OpenAI's
// automatic prefix caching, nothing to send. No server-side fallbacks.
import type OpenAI from 'openai';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../judge-client.ts';

/**
 * OpenAI rejects `max_tokens` on current models; some local servers only
 * honor `max_tokens`. Each wrapper names the parameter its wire requires.
 */
export type TokenParam = 'max_completion_tokens' | 'max_tokens';

export function openAiWireJudge(provider: string, model: string, client: OpenAI, tokenParam: TokenParam): JudgeClient {
  return {
    provider,
    model,
    judge: (request) => judge(client, model, tokenParam, request),
  };
}

async function judge(client: OpenAI, model: string, tokenParam: TokenParam, request: JudgeRequest): Promise<JudgeResult> {
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.chat.completions.create({
      model,
      [tokenParam]: request.maxTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: request.schema } },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    });
  } catch (err) {
    // Non-Error throws (strings, objects from proxies/local servers) must
    // still yield an informative note.
    return { ok: false, note: `api error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const choice = completion.choices[0];
  if (!choice) return { ok: false, note: 'no completion choice' };
  if (choice.message.refusal) return { ok: false, note: 'judge refused' };
  if (choice.finish_reason === 'length') return { ok: false, note: 'judge output truncated at max_tokens' };
  const text = choice.message.content;
  if (!text) return { ok: false, note: `no text content (finish_reason: ${choice.finish_reason})` };
  try {
    return { ok: true, verdict: JSON.parse(text) };
  } catch {
    return { ok: false, note: 'judge output failed schema parse' };
  }
}
