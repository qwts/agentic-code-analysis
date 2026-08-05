// GitHub Copilot conventions (docs.github.com custom-instructions support
// matrix and Copilot CLI guide, verified 2026-08-05). Profiles:
// `copilot-cli` (repo + agent files + user ~/.copilot), `copilot-cloud-agent`
// (repo + path-specific + all agent files), `copilot-code-review` (repo +
// path-specific + root AGENTS.md only). Applicable files are combined with
// NO general precedence order — represented as unordered, never invented.

import type {
  AdapterBinding,
  AdapterContext,
  AdapterResult,
  ConventionAdapter,
  CorpusDiagnostic,
  InstructionBinding,
  SemanticsEvidence,
  SessionProfileId,
} from '../model.ts';
import { parseFrontmatter, stringListField } from '../frontmatter.ts';
import { makeLocator, posixBasename, posixDirname } from '../paths.ts';

const MATRIX_SOURCE = 'https://docs.github.com/en/copilot/reference/custom-instructions-support';
const CLI_SOURCE =
  'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions';
const VERIFIED_AT = '2026-08-05';

function verified(source: string): SemanticsEvidence {
  return { status: 'verified', source, verifiedAt: VERIFIED_AT };
}

const AGENT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

function combined(
  profile: SessionProfileId,
  convention: string,
  scope: InstructionBinding['scope'],
  activation: InstructionBinding['activation'],
  charged: InstructionBinding['charged'],
  source: string,
): InstructionBinding {
  return {
    tool: 'copilot',
    profile,
    convention,
    scope,
    activation,
    cadence: activation === 'session-start' ? 'per-session' : 'once-on-trigger',
    charged,
    order: {
      kind: 'unordered',
      rule: 'instructions are combined; no general precedence order is defined',
    },
    conflict: 'combined-no-precedence',
    semantics: verified(source),
  };
}

export const copilotAdapter: ConventionAdapter = {
  id: 'copilot',
  async interpret(ctx: AdapterContext): Promise<AdapterResult> {
    const bindings: AdapterBinding[] = [];
    const diagnostics: CorpusDiagnostic[] = [];
    const repo = ctx.listings.find((listing) => listing.root.kind === 'repository');
    const users = ctx.listings.filter((listing) => listing.root.kind === 'user');
    const repoProfiles: readonly SessionProfileId[] = [
      'copilot-cli',
      'copilot-cloud-agent',
      'copilot-code-review',
    ];

    const emit = (
      rootId: string,
      path: string,
      contentKind: AdapterBinding['contentKind'],
      binding: InstructionBinding,
    ): void => {
      bindings.push({ rootId, path, contentKind, binding });
    };

    if (repo !== undefined) {
      for (const path of repo.paths) {
        const name = posixBasename(path);
        const dir = posixDirname(path);

        // Repository-wide instructions, all three profiles.
        if (path === '.github/copilot-instructions.md') {
          const content = await ctx.read(repo.root.id, path);
          if (content === null) continue;
          for (const profile of repoProfiles) {
            emit(repo.root.id, path, 'markdown', combined(
              profile,
              'copilot/repository-instructions',
              { kind: 'always' },
              'session-start',
              { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
              MATRIX_SOURCE,
            ));
          }
        }

        // Path-specific instructions with applyTo globs, all three profiles.
        if (path.startsWith('.github/instructions/') && path.endsWith('.instructions.md')) {
          const content = await ctx.read(repo.root.id, path);
          if (content === null) continue;
          const frontmatter = parseFrontmatter(content);
          if (frontmatter.present && 'error' in frontmatter) {
            diagnostics.push({
              severity: 'warn',
              message: `instructions frontmatter unreadable (${frontmatter.error}); applyTo scope unresolved`,
              locator: makeLocator(repo.root.id, path),
            });
            for (const profile of repoProfiles) {
              emit(repo.root.id, path, 'instructions-md', {
                ...combined(
                  profile,
                  'copilot/path-instructions',
                  { kind: 'unresolved', reason: 'malformed applyTo frontmatter' },
                  'unresolved',
                  { kind: 'unresolved', text: '', tokens: ctx.estimate('') },
                  MATRIX_SOURCE,
                ),
                cadence: 'unresolved',
              });
            }
            continue;
          }
          const applyTo = frontmatter.present ? stringListField(frontmatter, 'applyTo') : undefined;
          const body = frontmatter.present ? frontmatter.body : content;
          const scope: InstructionBinding['scope'] =
            applyTo === undefined ? { kind: 'always' } : { kind: 'glob', globs: applyTo };
          for (const profile of repoProfiles) {
            emit(repo.root.id, path, 'instructions-md', combined(
              profile,
              'copilot/path-instructions',
              scope,
              applyTo === undefined ? 'session-start' : 'on-path-access',
              { kind: 'body', text: body, tokens: ctx.estimate(body) },
              MATRIX_SOURCE,
            ));
          }
        }

        // Agent instruction files.
        if (AGENT_FILE_NAMES.includes(name) || path === '.claude/CLAUDE.md') {
          const content = await ctx.read(repo.root.id, path);
          if (content === null) continue;
          const charged = {
            kind: 'whole-file' as const,
            text: content,
            tokens: ctx.estimate(content),
          };
          const scope: InstructionBinding['scope'] =
            dir === '' || path === '.claude/CLAUDE.md'
              ? { kind: 'root' }
              : { kind: 'directory-subtree', directory: dir, via: 'cwd-or-touched' };
          // CLI and cloud agent read all agent files, root chain + nested.
          for (const profile of ['copilot-cli', 'copilot-cloud-agent'] as const) {
            emit(repo.root.id, path, 'markdown', combined(
              profile,
              'copilot/agent-instructions',
              scope,
              dir === '' ? 'session-start' : 'on-path-access',
              charged,
              profile === 'copilot-cli' ? CLI_SOURCE : MATRIX_SOURCE,
            ));
          }
          // Code review reads root AGENTS.md only.
          if (path === 'AGENTS.md') {
            emit(repo.root.id, path, 'markdown', combined(
              'copilot-code-review',
              'copilot/agent-instructions',
              { kind: 'root' },
              'session-start',
              charged,
              MATRIX_SOURCE,
            ));
          }
        }
      }
    }

    // User-level instructions: Copilot CLI only.
    for (const user of users) {
      for (const path of user.paths) {
        const isUserWide = path === '.copilot/copilot-instructions.md';
        const isUserPath =
          path.startsWith('.copilot/instructions/') && path.endsWith('.instructions.md');
        if (!isUserWide && !isUserPath) continue;
        const content = await ctx.read(user.root.id, path);
        if (content === null) continue;
        if (isUserWide) {
          emit(user.root.id, path, 'markdown', combined(
            'copilot-cli',
            'copilot/user-instructions',
            { kind: 'always' },
            'session-start',
            { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
            CLI_SOURCE,
          ));
          continue;
        }
        const frontmatter = parseFrontmatter(content);
        const applyTo =
          frontmatter.present && !('error' in frontmatter)
            ? stringListField(frontmatter, 'applyTo')
            : undefined;
        const body = frontmatter.present && !('error' in frontmatter) ? frontmatter.body : content;
        emit(user.root.id, path, 'instructions-md', combined(
          'copilot-cli',
          'copilot/user-path-instructions',
          applyTo === undefined ? { kind: 'always' } : { kind: 'glob', globs: applyTo },
          applyTo === undefined ? 'session-start' : 'on-path-access',
          { kind: 'body', text: body, tokens: ctx.estimate(body) },
          CLI_SOURCE,
        ));
      }
    }

    return { bindings, diagnostics };
  },
};
