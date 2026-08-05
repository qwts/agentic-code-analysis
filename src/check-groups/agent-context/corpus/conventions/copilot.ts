// GitHub Copilot custom instructions: repository-wide
// `.github/copilot-instructions.md` loads always; path-specific
// `.github/instructions/*.instructions.md` applies per its `applyTo` globs
// (front matter is loader-only and not charged). A missing `applyTo`
// degrades to unknown rather than a guessed scope. Sources:
// https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide
// and https://docs.github.com/en/copilot/reference/custom-instructions-support
// (verified 2026-08-04).
import { globList, parseFrontmatter } from '../frontmatter.ts';
import { fragment, unverified, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Origin } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const DOCS = 'https://docs.github.com/en/copilot/reference/custom-instructions-support';

export const copilotConvention: InstructionConvention = {
  id: 'copilot-instructions',
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
    if (origin !== 'repository') return [];
    const found: CandidateBinding[] = [];
    for (const path of snapshot.paths) {
      if (path === '.github/copilot-instructions.md') {
        const content = snapshot.content(path);
        if (content === undefined) continue;
        found.push({
          path,
          binding: {
            tool: 'copilot',
            convention: this.id,
            scopeDir: '',
            activation: 'always',
            fragments: [fragment('body', 'always', content, estimate)],
            semantics: verified(DOCS),
          },
        });
        continue;
      }
      if (path.startsWith('.github/instructions/') && path.endsWith('.instructions.md')) {
        const content = snapshot.content(path);
        if (content === undefined) continue;
        const parsed = parseFrontmatter(content);
        const globs = parsed.error === undefined ? globList(parsed.fields, 'applyTo') : undefined;
        if (globs === undefined) {
          found.push({
            path,
            binding: {
              tool: 'copilot',
              convention: 'copilot-path-instructions',
              scopeDir: '',
              activation: 'unknown',
              fragments: [fragment('body', 'unknown', content, estimate)],
              semantics: unverified(parsed.error ?? 'applyTo front matter missing'),
            },
          });
          continue;
        }
        found.push({
          path,
          binding: {
            tool: 'copilot',
            convention: 'copilot-path-instructions',
            scopeDir: '',
            pathGlobs: globs,
            activation: 'path',
            fragments: [fragment('body', 'path', parsed.body, estimate)],
            semantics: verified(DOCS),
          },
        });
      }
    }
    return found;
  },
};
