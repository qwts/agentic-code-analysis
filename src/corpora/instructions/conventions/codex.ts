// Codex AGENTS.md convention (developers.openai.com/codex/guides/agents-md,
// verified 2026-08-05). Profile `codex-local`: user-root
// .codex/AGENTS.override.md|AGENTS.md load first; then, in each repo
// directory from the root down to the CWD, the first match of
// AGENTS.override.md > AGENTS.md > configured fallback filenames.
// Concatenation root->down, closer overrides; the combined
// project_doc_max_bytes cap is applied at cascade resolution.

import type {
  AdapterBinding,
  AdapterContext,
  AdapterResult,
  ConventionAdapter,
  CorpusDiagnostic,
  InstructionBinding,
  SemanticsEvidence,
} from '../model.ts';
import { dirDepth, makeLocator, posixBasename, posixDirname } from '../paths.ts';

const SOURCE = 'https://developers.openai.com/codex/guides/agents-md';
const VERIFIED: SemanticsEvidence = {
  status: 'verified',
  source: SOURCE,
  verifiedAt: '2026-08-05',
};

export const CODEX_DEFAULT_MAX_BYTES = 32 * 1024;

function chainBinding(
  rank: number,
  scope: InstructionBinding['scope'],
  charged: InstructionBinding['charged'],
): InstructionBinding {
  return {
    tool: 'codex',
    profile: 'codex-local',
    convention: 'codex/agents-chain',
    scope,
    activation: 'session-start',
    cadence: 'per-session',
    charged,
    order: {
      kind: 'ordered',
      rule: 'global first, then root-to-CWD concatenation; closer file read later',
      rank,
    },
    conflict: 'closer-overrides',
    semantics: VERIFIED,
  };
}

export const codexAdapter: ConventionAdapter = {
  id: 'codex',
  async interpret(ctx: AdapterContext): Promise<AdapterResult> {
    const fallbacks = ctx.config.codexFallbackFilenames ?? [];
    const bindings: AdapterBinding[] = [];
    const diagnostics: CorpusDiagnostic[] = [];

    for (const listing of ctx.listings) {
      const names =
        listing.root.kind === 'user'
          ? ['.codex/AGENTS.override.md', '.codex/AGENTS.md']
          : null;
      if (names !== null) {
        // Global scope: override wins outright; only one file binds.
        for (const path of names) {
          if (!listing.paths.includes(path)) continue;
          const content = await ctx.read(listing.root.id, path);
          if (content === null) continue;
          if (content.trim() === '') {
            diagnostics.push({
              severity: 'info',
              message: 'codex skips empty instruction files',
              locator: makeLocator(listing.root.id, path),
            });
            continue;
          }
          bindings.push({
            rootId: listing.root.id,
            path,
            contentKind: 'markdown',
            binding: chainBinding(0, { kind: 'always' }, {
              kind: 'whole-file',
              text: content,
              tokens: ctx.estimate(content),
            }),
          });
          if (path === '.codex/AGENTS.override.md' && listing.paths.includes('.codex/AGENTS.md')) {
            diagnostics.push({
              severity: 'info',
              message: 'shadowed by .codex/AGENTS.override.md',
              locator: makeLocator(listing.root.id, '.codex/AGENTS.md'),
            });
          }
          break;
        }
        continue;
      }

      // Repository scope: per-directory winner along any future CWD chain.
      const candidateNames = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks];
      const byDir = new Map<string, string[]>();
      for (const path of listing.paths) {
        if (!candidateNames.includes(posixBasename(path))) continue;
        const dir = posixDirname(path);
        byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
      }
      for (const [dir, paths] of byDir) {
        const winner = candidateNames
          .map((name) => (dir === '' ? name : `${dir}/${name}`))
          .find((candidate) => paths.includes(candidate));
        if (winner === undefined) continue;
        for (const shadowed of paths) {
          if (shadowed !== winner) {
            diagnostics.push({
              severity: 'info',
              message: `shadowed by ${winner} in the same directory`,
              locator: makeLocator(listing.root.id, shadowed),
            });
          }
        }
        const content = await ctx.read(listing.root.id, winner);
        if (content === null) continue;
        if (content.trim() === '') {
          diagnostics.push({
            severity: 'info',
            message: 'codex skips empty instruction files',
            locator: makeLocator(listing.root.id, winner),
          });
          continue;
        }
        bindings.push({
          rootId: listing.root.id,
          path: winner,
          contentKind: 'markdown',
          binding: chainBinding(
            1 + dirDepth(dir),
            dir === '' ? { kind: 'root' } : { kind: 'directory-subtree', directory: dir, via: 'cwd' },
            { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
          ),
        });
      }
    }
    return { bindings, diagnostics };
  },
};
