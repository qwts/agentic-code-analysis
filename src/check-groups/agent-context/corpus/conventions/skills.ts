// Skills and slash commands under Claude Code's discovery roots: a skill's
// name/description routing metadata is paid continuously while its body
// loads only when the model selects it — the split the Fragment model
// exists for. Commands are manual invocations, excluded from automatic
// totals. Source: https://code.claude.com/docs/en/slash-commands and the
// Agent Skills specification (https://agentskills.io/specification),
// verified 2026-08-04.
import { parseFrontmatter } from '../frontmatter.ts';
import { fragment, unverified, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Origin } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const DOCS = 'https://code.claude.com/docs/en/slash-commands';

export const skillsConvention: InstructionConvention = {
  id: 'claude-skills',
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
    const skillsPrefix = origin === 'repository' ? '.claude/skills/' : 'skills/';
    const commandsPrefix = origin === 'repository' ? '.claude/commands/' : 'commands/';
    const found: CandidateBinding[] = [];
    for (const path of snapshot.paths) {
      if (path.startsWith(skillsPrefix) && path.endsWith('/SKILL.md')) {
        const candidate = skillBinding(snapshot, path, estimate);
        if (candidate) found.push(candidate);
        continue;
      }
      if (path.startsWith(commandsPrefix) && path.endsWith('.md')) {
        const content = snapshot.content(path);
        if (content === undefined) continue;
        found.push({
          path,
          binding: {
            tool: 'claude-code',
            convention: 'claude-commands',
            scopeDir: '',
            activation: 'manual',
            fragments: [fragment('body', 'manual', content, estimate)],
            semantics: verified(DOCS),
          },
        });
      }
    }
    return found;
  },
};

function skillBinding(snapshot: TreeSnapshot, path: string, estimate: Estimate): CandidateBinding | undefined {
  const content = snapshot.content(path);
  if (content === undefined) return undefined;
  const parsed = parseFrontmatter(content);
  const name = parsed.fields.get('name');
  const description = parsed.fields.get('description');
  if (parsed.error !== undefined || typeof name !== 'string' || typeof description !== 'string') {
    const reason = parsed.error ?? 'missing name/description front matter';
    return {
      path,
      binding: {
        tool: 'claude-code',
        convention: 'claude-skills',
        scopeDir: '',
        activation: 'unknown',
        fragments: [fragment('body', 'unknown', content, estimate)],
        semantics: unverified(`skill front matter unsupported: ${reason}`),
      },
    };
  }
  return {
    path,
    binding: {
      tool: 'claude-code',
      convention: 'claude-skills',
      scopeDir: '',
      activation: 'model-selected',
      fragments: [
        fragment('metadata', 'always', `${name}: ${description}`, estimate),
        fragment('body', 'model-selected', parsed.body, estimate),
      ],
      semantics: verified(DOCS),
    },
  };
}
