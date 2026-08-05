// OpenAI adapter: credential resolution over the shared OpenAI-wire
// transport. The SDK throws at construction when no credentials resolve
// (verified on openai@7), which maps directly to MissingCredentialsError.
import OpenAI from 'openai';
import { MissingCredentialsError, type JudgeClient } from '../judge-client.ts';
import { openAiWireJudge } from './openai-compatible.ts';

export function createOpenAiJudge(model: string, client?: OpenAI): JudgeClient {
  let openai: OpenAI;
  if (client) {
    openai = client;
  } else {
    try {
      openai = new OpenAI();
    } catch {
      throw new MissingCredentialsError('openai');
    }
    // The constructor also accepts admin-only credentials (OPENAI_ADMIN_KEY),
    // which cannot call chat.completions — that miss must be 78 at setup,
    // not degraded warns at judge time (review, PR #9).
    if (openai.apiKey === null) {
      throw new MissingCredentialsError('openai');
    }
  }
  return openAiWireJudge('openai', model, openai, 'max_completion_tokens');
}
