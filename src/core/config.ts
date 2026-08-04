// Consuming-repo configuration: aca.config.json holds the scope globs and the
// tier -> {provider, model} map (ACA-0003 D6 — model names are configuration,
// never code).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Tier = 'T1' | 'T2' | 'T3';

export interface TierRoute {
  provider: string;
  model: string;
}

export interface AcaConfig {
  include: string[];
  exclude: string[];
  tiers: Partial<Record<Tier, TierRoute>>;
}

export class ConfigError extends Error {}

const DEFAULTS: AcaConfig = { include: ['**'], exclude: [], tiers: {} };

export function loadConfig(repoRoot: string): AcaConfig {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, 'aca.config.json'), 'utf8');
  } catch {
    return DEFAULTS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`aca.config.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('aca.config.json must be a JSON object');
  }
  const cfg = parsed as Record<string, unknown>;
  return {
    include: stringArray(cfg, 'include') ?? DEFAULTS.include,
    exclude: stringArray(cfg, 'exclude') ?? DEFAULTS.exclude,
    tiers: tierMap(cfg),
  };
}

export function resolveTier(config: AcaConfig, tier: Tier): TierRoute {
  const provider = process.env['ACA_PROVIDER'];
  const model = process.env['ACA_MODEL'];
  if (provider && model) return { provider, model };
  const route = config.tiers[tier];
  if (!route) {
    throw new ConfigError(
      `no route for tier ${tier}: map it in aca.config.json under "tiers" ` +
        `(e.g. {"${tier}": {"provider": "anthropic", "model": "<model id>"}}) ` +
        `or set ACA_PROVIDER and ACA_MODEL`,
    );
  }
  return route;
}

function stringArray(cfg: Record<string, unknown>, key: string): string[] | undefined {
  const value = cfg[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`aca.config.json "${key}" must be an array of strings`);
  }
  return value as string[];
}

function tierMap(cfg: Record<string, unknown>): AcaConfig['tiers'] {
  const value = cfg['tiers'];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('aca.config.json "tiers" must be an object');
  }
  const tiers: AcaConfig['tiers'] = {};
  for (const [tier, route] of Object.entries(value)) {
    if (tier !== 'T1' && tier !== 'T2' && tier !== 'T3') {
      throw new ConfigError(`aca.config.json "tiers" has unknown tier "${tier}"`);
    }
    const r = route as Record<string, unknown>;
    if (typeof r?.['provider'] !== 'string' || typeof r?.['model'] !== 'string') {
      throw new ConfigError(`aca.config.json tier "${tier}" needs string "provider" and "model"`);
    }
    tiers[tier] = { provider: r['provider'], model: r['model'] };
  }
  return tiers;
}
