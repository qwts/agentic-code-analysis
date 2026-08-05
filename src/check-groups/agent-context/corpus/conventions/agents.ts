// AGENTS.md — the cross-tool convention: one file per directory, loaded
// root→working-directory as a chain, session-start cost within its scope.
// The same physical file is paid by several tools under their own documented
// semantics, so one candidate emits one binding per verified consumer —
// never a fictional "universal" cascade (design doc, convention matrix).
import { dirOf, fragment, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Origin } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const CONSUMERS = [
  { tool: 'codex', source: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md.md' },
  { tool: 'cursor', source: 'https://docs.cursor.com/context/rules' },
  { tool: 'windsurf', source: 'https://docs.devin.ai/desktop/cascade/agents-md' },
] as const;

export const agentsConvention: InstructionConvention = {
  id: 'agents-md',
  discover(snapshot: TreeSnapshot, _origin: Origin, estimate: Estimate): CandidateBinding[] {
    const found: CandidateBinding[] = [];
    for (const path of snapshot.paths) {
      if (path !== 'AGENTS.md' && !path.endsWith('/AGENTS.md')) continue;
      const content = snapshot.content(path);
      if (content === undefined) continue;
      const scopeDir = dirOf(path);
      for (const consumer of CONSUMERS) {
        found.push({
          path,
          binding: {
            tool: consumer.tool,
            convention: this.id,
            scopeDir,
            activation: 'always',
            fragments: [fragment('body', 'always', content, estimate)],
            semantics: verified(consumer.source),
          },
        });
      }
    }
    return found;
  },
};
