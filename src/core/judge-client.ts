// The JudgeClient port (ACA-0003 D2). Checks depend on this interface only —
// vendor SDKs appear exclusively inside src/core/adapters/. The interface is
// frozen: an adapter needing more forks rather than widening it.
import { ConfigError, type TierRoute } from './config.ts';

export interface JudgeRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export type JudgeResult = { ok: true; verdict: unknown } | { ok: false; note: string };

export interface JudgeClient {
  readonly provider: string;
  readonly model: string;
  judge(request: JudgeRequest): Promise<JudgeResult>;
}

export class MissingCredentialsError extends Error {
  constructor(provider: string) {
    super(`no ${provider} credentials resolve`);
  }
}

/** Transport statuses that mean the judge rejected the account itself —
 * auth or quota — on any wire (ACA-0011). Providers also hide account
 * rejection behind other statuses; each adapter names its own shapes. */
export const GATE_DOWN_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);

/** The judge rejected the account at judge time: MissingCredentialsError
 * arriving late (ACA-0011). Adapters throw this instead of degrading, so the
 * run stops — a per-file warn must always mean a judge looked. */
export class JudgeUnavailableError extends Error {
  constructor(provider: string, note: string) {
    super(`${provider} judge unavailable — ${note}`);
  }
}

export async function createJudgeClient(route: TierRoute): Promise<JudgeClient> {
  switch (route.provider) {
    case 'anthropic': {
      const { createAnthropicJudge } = await import('./adapters/anthropic.ts');
      return createAnthropicJudge(route.model);
    }
    case 'openai': {
      const { createOpenAiJudge } = await import('./adapters/openai.ts');
      return createOpenAiJudge(route.model);
    }
    case 'local': {
      const { createLocalJudge } = await import('./adapters/local.ts');
      return createLocalJudge(route.model);
    }
    default:
      throw new ConfigError(`unknown provider "${route.provider}" (supported: anthropic, openai, local)`);
  }
}
