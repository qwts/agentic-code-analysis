// Agent Skills specification (agentskills.io/specification, verified
// 2026-08-05): SKILL.md frontmatter validation and the metadata/body/resource
// split shared by the Claude Code and Windsurf/Devin adapters. This file
// owns the spec; host adapters own where skills live and which profiles
// pay for them.

import { parseFrontmatter, stringField } from '../frontmatter.ts';
import { posixBasename, posixDirname } from '../paths.ts';

export const AGENT_SKILLS_SOURCE = 'https://agentskills.io/specification';
export const AGENT_SKILLS_VERIFIED_AT = '2026-08-05';

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface SkillParse {
  readonly valid: boolean;
  readonly name?: string;
  readonly description?: string;
  /** What every session pays at startup: the listing metadata. */
  readonly metadataText: string;
  /** What loads on activation: the full SKILL.md body. */
  readonly body: string;
  readonly problems: readonly string[];
}

/** Parse and validate one SKILL.md at `<...>/<skill-dir>/SKILL.md`. */
export function parseSkill(path: string, content: string): SkillParse {
  const problems: string[] = [];
  const skillDir = posixBasename(posixDirname(path));
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.present) {
    return { valid: false, metadataText: '', body: content, problems: ['missing frontmatter'] };
  }
  if ('error' in frontmatter) {
    return { valid: false, metadataText: '', body: frontmatter.body, problems: [frontmatter.error] };
  }
  const name = stringField(frontmatter, 'name');
  const description = stringField(frontmatter, 'description');
  if (name === undefined) problems.push('missing required `name`');
  else {
    if (name.length < 1 || name.length > 64) problems.push('`name` must be 1-64 characters');
    if (!NAME_PATTERN.test(name)) {
      problems.push('`name` must be lowercase alphanumerics with single hyphens');
    }
    if (name !== skillDir) {
      problems.push(`\`name\` (${name}) must match the skill directory (${skillDir})`);
    }
  }
  if (description === undefined) problems.push('missing required `description`');
  else if (description.length < 1 || description.length > 1024) {
    problems.push('`description` must be 1-1024 characters');
  }
  const metadataText =
    name !== undefined || description !== undefined
      ? `${name ?? skillDir}: ${description ?? ''}`
      : '';
  return {
    valid: problems.length === 0,
    name,
    description,
    metadataText,
    body: frontmatter.body,
    problems,
  };
}

/**
 * Group a root listing's paths into skill directories under `skillsDir`
 * ('<skillsDir>/<name>/SKILL.md' plus its resource files).
 */
export function findSkillDirs(
  paths: readonly string[],
  skillsDir: string,
): readonly { readonly dir: string; readonly skillFile: string; readonly resources: readonly string[] }[] {
  const byDir = new Map<string, { skillFile?: string; resources: string[] }>();
  const prefix = `${skillsDir}/`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue;
    const dir = `${skillsDir}/${rest.slice(0, slash)}`;
    const entry = byDir.get(dir) ?? { resources: [] };
    if (rest.slice(slash + 1) === 'SKILL.md') entry.skillFile = path;
    else entry.resources.push(path);
    byDir.set(dir, entry);
  }
  const result = [];
  for (const [dir, entry] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.skillFile !== undefined) {
      result.push({ dir, skillFile: entry.skillFile, resources: entry.resources });
    }
  }
  return result;
}
