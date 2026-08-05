// Cursor rules: `.cursor/rules/**/*.mdc` (nested `.cursor` directories
// scope to their subtree) with front-matter activation — alwaysApply,
// globs, or description-routed (description metadata stays visible, body
// loads on model selection). A rule with none of those is manually invoked.
// Legacy `.cursorrules` is discovered but unverified: current docs do not
// define its modern precedence, so no activation is guessed. Source:
// https://docs.cursor.com/context/rules (verified 2026-08-04).
import { globList, parseFrontmatter } from '../frontmatter.ts';
import { fragment, unverified, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Fragment, Origin, ToolBinding } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const DOCS = 'https://docs.cursor.com/context/rules';

export const cursorConvention: InstructionConvention = {
  id: 'cursor-rules',
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
    if (origin !== 'repository') return [];
    const found: CandidateBinding[] = [];
    for (const path of snapshot.paths) {
      if (path === '.cursorrules') {
        const content = snapshot.content(path);
        if (content === undefined) continue;
        found.push({
          path,
          binding: {
            tool: 'cursor',
            convention: 'cursorrules-legacy',
            scopeDir: '',
            activation: 'unknown',
            fragments: [fragment('body', 'unknown', content, estimate)],
            semantics: unverified('legacy .cursorrules — modern precedence undefined in current docs'),
          },
        });
        continue;
      }
      const rulesAt = path.indexOf('.cursor/rules/');
      if (rulesAt === -1 || !path.endsWith('.mdc')) continue;
      if (rulesAt > 0 && path[rulesAt - 1] !== '/') continue;
      const content = snapshot.content(path);
      if (content === undefined) continue;
      const scopeDir = rulesAt === 0 ? '' : path.slice(0, rulesAt - 1);
      found.push({ path, binding: ruleBinding(content, scopeDir, estimate) });
    }
    return found;
  },
};

function ruleBinding(content: string, scopeDir: string, estimate: Estimate): ToolBinding {
  const base = { tool: 'cursor' as const, convention: 'cursor-rules', scopeDir };
  const parsed = parseFrontmatter(content);
  if (parsed.error !== undefined && parsed.error !== 'no front matter') {
    return {
      ...base,
      activation: 'unknown',
      fragments: [fragment('body', 'unknown', content, estimate)],
      semantics: unverified(`front matter unsupported: ${parsed.error}`),
    };
  }
  const body = parsed.error === 'no front matter' ? content : parsed.body;
  const globs = globList(parsed.fields, 'globs');
  const description = parsed.fields.get('description');
  if (parsed.fields.get('alwaysApply') === 'true') {
    return { ...base, activation: 'always', fragments: [fragment('body', 'always', body, estimate)], semantics: verified(DOCS) };
  }
  if (globs !== undefined && globs.length > 0) {
    return { ...base, pathGlobs: globs, activation: 'path', fragments: [fragment('body', 'path', body, estimate)], semantics: verified(DOCS) };
  }
  if (typeof description === 'string' && description !== '') {
    const fragments: Fragment[] = [fragment('metadata', 'always', description, estimate), fragment('body', 'model-selected', body, estimate)];
    return { ...base, activation: 'model-selected', fragments, semantics: verified(DOCS) };
  }
  return { ...base, activation: 'manual', fragments: [fragment('body', 'manual', body, estimate)], semantics: verified(DOCS) };
}
