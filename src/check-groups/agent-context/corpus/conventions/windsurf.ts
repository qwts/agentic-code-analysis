// Windsurf rules: `.windsurf/rules/*.md` with a `trigger` front-matter mode
// (always_on, glob, model_decision, manual); model_decision keeps its
// description visible while the body loads on selection. Legacy
// `.windsurfrules` is still read by current tooling but its activation and
// precedence are not fully documented, so it is discovered unverified.
// Source: https://docs.windsurf.com/windsurf/cascade/memories
// (verified 2026-08-04).
import { globList, parseFrontmatter } from '../frontmatter.ts';
import { fragment, unverified, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Fragment, Origin, ToolBinding } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const DOCS = 'https://docs.windsurf.com/windsurf/cascade/memories';

export const windsurfConvention: InstructionConvention = {
  id: 'windsurf-rules',
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
    if (origin !== 'repository') return [];
    const found: CandidateBinding[] = [];
    for (const path of snapshot.paths) {
      if (path === '.windsurfrules') {
        const content = snapshot.content(path);
        if (content === undefined) continue;
        found.push({
          path,
          binding: {
            tool: 'windsurf',
            convention: 'windsurfrules-legacy',
            scopeDir: '',
            activation: 'unknown',
            fragments: [fragment('body', 'unknown', content, estimate)],
            semantics: unverified('legacy .windsurfrules — activation/precedence undefined in current docs'),
          },
        });
        continue;
      }
      if (!path.startsWith('.windsurf/rules/') || !path.endsWith('.md')) continue;
      const content = snapshot.content(path);
      if (content === undefined) continue;
      found.push({ path, binding: ruleBinding(content, estimate) });
    }
    return found;
  },
};

function ruleBinding(content: string, estimate: Estimate): ToolBinding {
  const base = { tool: 'windsurf' as const, convention: 'windsurf-rules', scopeDir: '' };
  const parsed = parseFrontmatter(content);
  if (parsed.error !== undefined) {
    return {
      ...base,
      activation: 'unknown',
      fragments: [fragment('body', 'unknown', content, estimate)],
      semantics: unverified(`front matter unsupported: ${parsed.error}`),
    };
  }
  const body = parsed.body;
  const trigger = parsed.fields.get('trigger');
  if (trigger === 'always_on') {
    return { ...base, activation: 'always', fragments: [fragment('body', 'always', body, estimate)], semantics: verified(DOCS) };
  }
  if (trigger === 'glob') {
    const globs = globList(parsed.fields, 'globs') ?? [];
    return { ...base, pathGlobs: globs, activation: 'path', fragments: [fragment('body', 'path', body, estimate)], semantics: verified(DOCS) };
  }
  if (trigger === 'model_decision') {
    const description = parsed.fields.get('description');
    const fragments: Fragment[] =
      typeof description === 'string' && description !== ''
        ? [fragment('metadata', 'always', description, estimate), fragment('body', 'model-selected', body, estimate)]
        : [fragment('body', 'model-selected', body, estimate)];
    return { ...base, activation: 'model-selected', fragments, semantics: verified(DOCS) };
  }
  if (trigger === 'manual') {
    return { ...base, activation: 'manual', fragments: [fragment('body', 'manual', body, estimate)], semantics: verified(DOCS) };
  }
  return {
    ...base,
    activation: 'unknown',
    fragments: [fragment('body', 'unknown', content, estimate)],
    semantics: unverified(`trigger mode ${JSON.stringify(trigger ?? 'missing')} not documented`),
  };
}
