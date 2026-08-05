// Cursor conventions (cursor.com/docs/context/rules and /cli/using,
// verified 2026-08-05). Profiles: `cursor-editor-agent` (.cursor/rules
// *.mdc incl. nested, AGENTS.md root + subdirs, legacy .cursorrules) and
// `cursor-cli` (.cursor/rules identically, plus AGENTS.md and CLAUDE.md at
// the project root). Team/User rules are app state — a documented gap, not
// files. Legacy .cursorrules has no source-verifiable modern precedence:
// found, semantics unverified.

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
import { booleanField, parseFrontmatter, stringField, stringListField } from '../frontmatter.ts';
import { makeLocator, posixBasename, posixDirname } from '../paths.ts';

const RULES_SOURCE = 'https://cursor.com/docs/context/rules';
const CLI_SOURCE = 'https://cursor.com/docs/cli/using';
const VERIFIED_AT = '2026-08-05';

function verified(source: string): SemanticsEvidence {
  return { status: 'verified', source, verifiedAt: VERIFIED_AT };
}

const ORDER_RULE = 'Team -> Project -> User; earlier sources take precedence on conflict';

function rulesBinding(
  profile: SessionProfileId,
  convention: string,
  scope: InstructionBinding['scope'],
  activation: InstructionBinding['activation'],
  charged: InstructionBinding['charged'],
  source: string,
): InstructionBinding {
  return {
    tool: 'cursor',
    profile,
    convention,
    scope,
    activation,
    cadence:
      activation === 'session-start'
        ? 'per-session'
        : activation === 'unresolved'
          ? 'unresolved'
          : 'once-on-trigger',
    charged,
    order: { kind: 'ordered', rule: ORDER_RULE, rank: 100 },
    conflict: 'earlier-overrides',
    semantics: verified(source),
  };
}

export const cursorAdapter: ConventionAdapter = {
  id: 'cursor',
  async interpret(ctx: AdapterContext): Promise<AdapterResult> {
    const bindings: AdapterBinding[] = [];
    const diagnostics: CorpusDiagnostic[] = [];
    const repo = ctx.listings.find((listing) => listing.root.kind === 'repository');
    if (repo === undefined) return { bindings, diagnostics };
    const bothProfiles: readonly SessionProfileId[] = ['cursor-editor-agent', 'cursor-cli'];

    for (const path of repo.paths) {
      const name = posixBasename(path);
      const dir = posixDirname(path);

      // .cursor/rules — .mdc rules, root or nested; identical in the CLI.
      const rulesMatch = /^(?:(.*)\/)?\.cursor\/rules\/[^/]+$/.exec(path);
      if (rulesMatch !== null) {
        const base = rulesMatch[1] ?? '';
        if (name.endsWith('.md')) {
          diagnostics.push({
            severity: 'info',
            message: '.md files in .cursor/rules are ignored unless they carry frontmatter metadata',
            locator: makeLocator(repo.root.id, path),
          });
          continue;
        }
        if (!name.endsWith('.mdc')) continue;
        const content = await ctx.read(repo.root.id, path);
        if (content === null) continue;
        const frontmatter = parseFrontmatter(content);
        if (!frontmatter.present || 'error' in frontmatter) {
          const reason = !frontmatter.present
            ? 'missing .mdc frontmatter'
            : `malformed .mdc frontmatter (${frontmatter.error})`;
          diagnostics.push({
            severity: 'warn',
            message: `${reason}; activation unresolved`,
            locator: makeLocator(repo.root.id, path),
          });
          for (const profile of bothProfiles) {
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule',
                { kind: 'unresolved', reason },
                'unresolved',
                { kind: 'unresolved', text: '', tokens: ctx.estimate('') },
                RULES_SOURCE,
              ),
            });
          }
          continue;
        }
        const description = stringField(frontmatter, 'description');
        const globs = stringListField(frontmatter, 'globs');
        const alwaysApply = booleanField(frontmatter, 'alwaysApply') ?? false;
        const body = frontmatter.body;
        // Nested rule directories scope to their subtree; globs are taken
        // as written and re-anchored under the subtree.
        const anchoredGlobs =
          globs === undefined
            ? undefined
            : base === ''
              ? globs
              : globs.map((glob) => `${base}/${glob}`);
        for (const profile of bothProfiles) {
          const source = profile === 'cursor-cli' ? CLI_SOURCE : RULES_SOURCE;
          if (alwaysApply) {
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule-always',
                base === '' ? { kind: 'always' } : { kind: 'directory-subtree', directory: base, via: 'cwd-or-touched' },
                'session-start',
                { kind: 'body', text: body, tokens: ctx.estimate(body) },
                source,
              ),
            });
          } else if (anchoredGlobs !== undefined) {
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule-auto-attached',
                { kind: 'glob', globs: anchoredGlobs },
                'on-path-access',
                { kind: 'body', text: body, tokens: ctx.estimate(body) },
                source,
              ),
            });
          } else if (description !== undefined) {
            // Agent-requested: description always visible, body on decision.
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule-metadata',
                { kind: 'always' },
                'session-start',
                {
                  kind: 'frontmatter-fields',
                  fields: ['description'],
                  text: description,
                  tokens: ctx.estimate(description),
                },
                source,
              ),
            });
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule-agent-requested',
                { kind: 'always' },
                'model-decision',
                { kind: 'body', text: body, tokens: ctx.estimate(body) },
                source,
              ),
            });
          } else {
            bindings.push({
              rootId: repo.root.id,
              path,
              contentKind: 'mdc-rule',
              binding: rulesBinding(
                profile,
                'cursor/project-rule-manual',
                { kind: 'always' },
                'on-invocation',
                { kind: 'body', text: body, tokens: ctx.estimate(body) },
                source,
              ),
            });
          }
        }
        continue;
      }

      // AGENTS.md: root or subtree in the editor; root only (plus
      // CLAUDE.md) in the CLI.
      if (name === 'AGENTS.md') {
        const content = await ctx.read(repo.root.id, path);
        if (content === null) continue;
        const charged = {
          kind: 'whole-file' as const,
          text: content,
          tokens: ctx.estimate(content),
        };
        bindings.push({
          rootId: repo.root.id,
          path,
          contentKind: 'markdown',
          binding: rulesBinding(
            'cursor-editor-agent',
            'cursor/agents-md',
            dir === '' ? { kind: 'root' } : { kind: 'directory-subtree', directory: dir, via: 'touched' },
            dir === '' ? 'session-start' : 'on-path-access',
            charged,
            RULES_SOURCE,
          ),
        });
        if (dir === '') {
          bindings.push({
            rootId: repo.root.id,
            path,
            contentKind: 'markdown',
            binding: rulesBinding(
              'cursor-cli',
              'cursor/agents-md',
              { kind: 'root' },
              'session-start',
              charged,
              CLI_SOURCE,
            ),
          });
        }
      }
      if (path === 'CLAUDE.md') {
        const content = await ctx.read(repo.root.id, path);
        if (content === null) continue;
        bindings.push({
          rootId: repo.root.id,
          path,
          contentKind: 'markdown',
          binding: rulesBinding(
            'cursor-cli',
            'cursor/claude-md',
            { kind: 'root' },
            'session-start',
            { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
            CLI_SOURCE,
          ),
        });
      }

      // Legacy .cursorrules: recognized, semantics unverified.
      if (path === '.cursorrules') {
        const content = await ctx.read(repo.root.id, path);
        if (content === null) continue;
        diagnostics.push({
          severity: 'warn',
          message:
            'legacy .cursorrules found; current documentation does not define its precedence or activation',
          locator: makeLocator(repo.root.id, path),
        });
        bindings.push({
          rootId: repo.root.id,
          path,
          contentKind: 'markdown',
          binding: {
            tool: 'cursor',
            profile: 'cursor-editor-agent',
            convention: 'cursor/legacy-cursorrules',
            scope: { kind: 'unresolved', reason: 'legacy file; activation undocumented' },
            activation: 'unresolved',
            cadence: 'unresolved',
            charged: { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
            order: { kind: 'unresolved', reason: 'legacy file; precedence undocumented' },
            conflict: 'unresolved',
            semantics: {
              status: 'legacy',
              reason: 'still recognized by Cursor, but current docs define no precedence/activation',
              source: RULES_SOURCE,
            },
          },
        });
      }
    }

    return { bindings, diagnostics };
  },
};
