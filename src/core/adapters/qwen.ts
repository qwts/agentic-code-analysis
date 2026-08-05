// Qwen adapter: OpenAI-compatible chat transport with provider-specific,
// bounded thinking. JudgeRequest.maxTokens remains the visible-answer budget;
// Qwen receives the same independent cap for its hidden reasoning. The fork is
// deliberate: Qwen account errors and thinking controls differ from OpenAI's.
import OpenAI from 'openai';
import { ConfigError } from '../config.ts';
import {
  GATE_DOWN_STATUSES,
  JudgeUnavailableError,
  MissingCredentialsError,
  type JudgeClient,
  type JudgeRequest,
  type JudgeResult,
} from '../judge-client.ts';

type QwenChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  enable_thinking: true;
  thinking_budget: number;
};

const DEPLETED_429_CODES: ReadonlySet<string> = new Set([
  'CommodityNotPurchased',
  'PrepaidBillOverdue',
  'PostpaidBillOverdue',
]);

export function createQwenJudge(model: string, client?: OpenAI): JudgeClient {
  let qwen = client;
  if (!qwen) {
    const apiKey = process.env['QWEN_API_KEY'];
    const baseURL = process.env['QWEN_BASE_URL'];
    if (!apiKey) throw new MissingCredentialsError('qwen');
    if (!baseURL) throw new ConfigError('QWEN_BASE_URL is required for the qwen provider');
    qwen = new OpenAI({ apiKey, baseURL });
  }
  return {
    provider: 'qwen',
    model,
    judge: (request) => judge(qwen, model, request),
  };
}

async function judge(client: OpenAI, model: string, request: JudgeRequest): Promise<JudgeResult> {
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  const params: QwenChatParams = {
    model,
    max_tokens: request.maxTokens,
    enable_thinking: true,
    thinking_budget: request.maxTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: request.schema } },
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
  };
  try {
    completion = await client.chat.completions.create(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: unknown } | null)?.status;
    const code = (err as { code?: unknown } | null)?.code;
    const accountRejected =
      typeof status === 'number' &&
      (GATE_DOWN_STATUSES.has(status) ||
        (status === 400 && code === 'Arrearage') ||
        (status === 429 && typeof code === 'string' && DEPLETED_429_CODES.has(code)));
    if (accountRejected) throw new JudgeUnavailableError('qwen', message);
    return { ok: false, note: `api error: ${message}` };
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
