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
  }
  return openAiWireJudge('openai', model, openai, 'max_completion_tokens');
}
