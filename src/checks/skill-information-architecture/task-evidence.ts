// Versioned `.aca/<check>.json` workload evidence. Parsing is strict because
// malformed frequency or escaping resource claims must not quietly turn into
// model-invented workload grounding.
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { ConfigError } from '../../core/config.ts';
import { SESSION_PROFILES, type SessionProfileId } from '../../corpora/instructions/index.ts';
import type { SkillPackage, TaskEvidence, TaskScenario } from './model.ts';

export const SIDECAR_PATH = '.aca/skill-information-architecture.json';
export const TASK_EVIDENCE_VERSION = 'skill-task-evidence-v2';

interface RawScenario {
  id?: unknown;
  description?: unknown;
  profile?: unknown;
  frequency?: unknown;
  value?: unknown;
  critical?: unknown;
  requiredConcepts?: unknown;
  expectedResources?: unknown;
  observedReads?: unknown;
}

function fail(detail: string): never {
  throw new ConfigError(`${SIDECAR_PATH}: ${detail}`);
}

const strings = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) fail(`${field} must be an array of non-empty strings`);
  return [...new Set(value as string[])];
};

function resourcePaths(value: unknown, field: string, pkg: SkillPackage): string[] {
  const members = new Set(pkg.resources.map((resource) => resource.path));
  const paths = strings(value, field).map((entry) => {
    const portable = entry.replaceAll('\\', '/');
    if (/^[A-Za-z]:/u.test(portable) || portable.startsWith('/')) fail(`${field} must contain package-relative resource paths: ${entry}`);
    const fragment = portable.indexOf('#');
    const resource = fragment === -1 ? portable : portable.slice(0, fragment);
    if (resource.trim() === '') fail(`${field} must name a resource before any fragment: ${entry}`);
    const path = posix.normalize(posix.join(pkg.packageDir, resource));
    if (path !== pkg.packageDir && !path.startsWith(`${pkg.packageDir}/`)) fail(`${field} escapes package ${pkg.packageId}: ${entry}`);
    if (!members.has(path)) fail(`${field} names an unknown package resource: ${entry}`);
    return path;
  });
  return [...new Set(paths)];
}

function number(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${field} must be a finite non-negative number`);
  return value;
}

function scenarioOf(raw: RawScenario, index: number, pkg: SkillPackage): TaskScenario {
  const prefix = `packages.${pkg.packageId}.scenarios[${index}]`;
  if (typeof raw !== 'object' || raw === null) fail(`${prefix} must be an object`);
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(raw.id)) fail(`${prefix}.id must be a stable bare id`);
  if (typeof raw.description !== 'string' || raw.description.trim() === '') fail(`${prefix}.description must be non-empty`);
  if (raw.profile !== undefined && (!(SESSION_PROFILES as readonly unknown[]).includes(raw.profile))) fail(`${prefix}.profile is unknown`);
  if (raw.critical !== undefined && typeof raw.critical !== 'boolean') fail(`${prefix}.critical must be boolean`);
  return {
    id: raw.id,
    description: raw.description,
    ...(raw.profile !== undefined ? { profile: raw.profile as SessionProfileId } : {}),
    ...(number(raw.frequency, `${prefix}.frequency`) !== undefined ? { frequency: raw.frequency as number } : {}),
    ...(number(raw.value, `${prefix}.value`) !== undefined ? { value: raw.value as number } : {}),
    critical: raw.critical === true,
    requiredConcepts: strings(raw.requiredConcepts, `${prefix}.requiredConcepts`),
    expectedResources: resourcePaths(raw.expectedResources, `${prefix}.expectedResources`, pkg),
    observedReads: resourcePaths(raw.observedReads, `${prefix}.observedReads`, pkg),
  };
}

export function parseTaskEvidence(raw: unknown, pkg: SkillPackage): TaskEvidence {
  const document = raw as { schemaVersion?: unknown; packages?: unknown };
  if (typeof document !== 'object' || document === null || document.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof document.packages !== 'object' || document.packages === null || Array.isArray(document.packages)) fail('packages must be an object');
  const entry = (document.packages as Record<string, unknown>)[pkg.packageId];
  if (entry === undefined) return { schemaVersion: 1, basis: 'cohesion-only', scenarios: [] };
  const packageEntry = entry as { scenarios?: unknown };
  if (typeof packageEntry !== 'object' || packageEntry === null || !Array.isArray(packageEntry.scenarios)) fail(`packages.${pkg.packageId}.scenarios must be an array`);
  const scenarios = packageEntry.scenarios.map((scenario, index) => scenarioOf(scenario as RawScenario, index, pkg));
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) fail(`packages.${pkg.packageId} has duplicate scenario ids`);
  return { schemaVersion: 1, basis: scenarios.length > 0 ? 'workload-grounded' : 'cohesion-only', scenarios };
}

export function loadTaskEvidence(repoRoot: string, packages: readonly SkillPackage[]): Map<string, TaskEvidence> {
  const file = posix.join(repoRoot.replaceAll('\\', '/'), SIDECAR_PATH);
  if (!existsSync(file)) return new Map(packages.map((pkg) => [pkg.packageId, { schemaVersion: 1, basis: 'cohesion-only', scenarios: [] }]));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid JSON — ${(error as Error).message}`);
  }
  return new Map(packages.map((pkg) => [pkg.packageId, parseTaskEvidence(raw, pkg)]));
}
