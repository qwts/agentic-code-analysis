// Local adapter: zero-egress judging against an OpenAI-compatible server on
// this machine (LM Studio, Ollama). Exists so a private repo can run the
// check with no file content leaving the box (suite design, security
// posture). No credentials — local servers ignore the API key.
import OpenAI from 'openai';
import type { JudgeClient } from '../judge-client.ts';
import { openAiWireJudge } from './openai-compatible.ts';

// LM Studio's default endpoint; Ollama users set ACA_LOCAL_BASE_URL=http://localhost:11434/v1
const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

export function createLocalJudge(model: string, client?: OpenAI): JudgeClient {
  const local =
    client ??
    new OpenAI({
      baseURL: process.env['ACA_LOCAL_BASE_URL'] ?? DEFAULT_BASE_URL,
      apiKey: 'local',
    });
  return openAiWireJudge('local', model, local, 'max_tokens');
}
