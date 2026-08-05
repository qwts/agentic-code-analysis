// Claude Code conventions (code.claude.com/docs/en/memory and /skills,
// verified 2026-08-05). Profiles: `claude-local` (full user + project
// corpus) and `claude-cloud` (repository files only — cloud sessions do
// not read local user files; account-synced skills are a documented gap).
//
// Memory: user CLAUDE.md + rules load before project scope; project
// CLAUDE.md/.claude/CLAUDE.md + CLAUDE.local.md concatenate root->CWD at
// launch, below-CWD files load on access. Block-level HTML comments are
// stripped before injection, so charged text is comment-stripped. `@path`
// imports expand at launch (depth <= 4); external imports in project scope
// are approval-gated. Skills/commands follow the Agent Skills split.

import type {
  AdapterBinding,
  AdapterContext,
  AdapterResult,
  ContentProjection,
  ConventionAdapter,
  CorpusDiagnostic,
  InstructionBinding,
  RootListing,
  SemanticsEvidence,
  SessionProfileId,
} from '../model.ts';
import { parseFrontmatter, stringField, stringListField } from '../frontmatter.ts';
import { dirDepth, makeLocator, posixBasename, posixDirname } from '../paths.ts';
import {
  AGENT_SKILLS_SOURCE,
  AGENT_SKILLS_VERIFIED_AT,
  findSkillDirs,
  parseSkill,
} from './agent-skills.ts';

const MEMORY_SOURCE = 'https://code.claude.com/docs/en/memory';
const SKILLS_SOURCE = 'https://code.claude.com/docs/en/skills';
const VERIFIED_AT = '2026-08-05';
const MEMORY_VERIFIED: SemanticsEvidence = {
  status: 'verified',
  source: MEMORY_SOURCE,
  verifiedAt: VERIFIED_AT,
};
const SKILLS_VERIFIED: SemanticsEvidence = {
  status: 'verified',
  source: SKILLS_SOURCE,
  verifiedAt: VERIFIED_AT,
};

const IMPORT_MAX_DEPTH = 4;
const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/**
 * Strip block-level HTML comments outside fenced code blocks — the
 * documented projection for memory-file content.
 */
export function stripBlockComments(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inComment = false;
  for (const line of lines) {
    if (!inComment && /^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let rest = line;
    let kept = '';
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) {
          rest = '';
        } else {
          inComment = false;
          rest = rest.slice(end + 3);
        }
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) {
          kept += rest;
          rest = '';
        } else {
          kept += rest.slice(0, start);
          inComment = true;
          rest = rest.slice(start + 4);
        }
      }
    }
    if (kept.trim() !== '' || (line.trim() === '' && !inComment)) out.push(kept);
  }
  return out.join("\n");
}

/** `@path` import references outside code spans and fences. */
export function findImports(content: string): readonly string[] {
  const refs: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Remove inline code spans, then collect @path tokens.
    const withoutSpans = line.replace(/`[^`]*`/g, '');
    for (const match of withoutSpans.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const ref = match[1];
      if (ref !== undefined && ref !== '') refs.push(ref.replace(/[.,;:)\]]+$/, ''));
    }
  }
  return refs;
}

interface MemoryTarget {
  readonly rootListing: RootListing;
  readonly path: string;
  readonly scopeDir: string;
  readonly userScope: boolean;
  readonly rank: number;
  readonly belowCwd: boolean;
}

function memoryBinding(
  profile: SessionProfileId,
  target: Pick<MemoryTarget, 'scopeDir' | 'rank' | 'belowCwd'>,
  convention: string,
  charged: ContentProjection,
): InstructionBinding {
  return {
    tool: 'claude-code',
    profile,
    convention,
    scope:
      target.scopeDir === ''
        ? { kind: 'root' }
        : {
            kind: 'directory-subtree',
            directory: target.scopeDir,
            // Files between the root and the CWD load at launch; deeper
            // ones load when their subtree is touched — either satisfies.
            via: target.belowCwd ? 'cwd-or-touched' : 'cwd',
          },
    activation: target.belowCwd ? 'on-path-access' : 'session-start',
    cadence: target.belowCwd ? 'once-on-trigger' : 'per-session',
    charged,
    order: {
      kind: 'ordered',
      rule: 'user scope before project scope; root-to-CWD; CLAUDE.local.md after CLAUDE.md',
      rank: target.rank,
    },
    conflict: 'later-overrides',
    semantics: MEMORY_VERIFIED,
  };
}

export const claudeAdapter: ConventionAdapter = {
  id: 'claude-code',
  async interpret(ctx: AdapterContext): Promise<AdapterResult> {
    const bindings: AdapterBinding[] = [];
    const diagnostics: CorpusDiagnostic[] = [];
    const repo = ctx.listings.find((listing) => listing.root.kind === 'repository');
    const users = ctx.listings.filter((listing) => listing.root.kind === 'user');

    const emitForProfiles = (
      rootId: string,
      path: string,
      contentKind: AdapterBinding['contentKind'],
      make: (profile: SessionProfileId) => InstructionBinding,
      profiles: readonly SessionProfileId[],
    ): void => {
      for (const profile of profiles) {
        bindings.push({ rootId, path, contentKind, binding: make(profile) });
      }
    };

    // ---- memory files (CLAUDE.md family), with import expansion ----
    const memoryTargets: MemoryTarget[] = [];
    for (const user of users) {
      if (user.paths.includes('.claude/CLAUDE.md')) {
        memoryTargets.push({
          rootListing: user,
          path: '.claude/CLAUDE.md',
          scopeDir: '',
          userScope: true,
          rank: 0,
          belowCwd: false,
        });
      }
      // User rules load before project rules.
      for (const path of user.paths) {
        if (/^\.claude\/rules\/.+\.md$/.test(path)) {
          memoryTargets.push({
            rootListing: user,
            path,
            scopeDir: '',
            userScope: true,
            rank: 5,
            belowCwd: false,
          });
        }
      }
    }
    if (repo !== undefined) {
      const both =
        repo.paths.includes('CLAUDE.md') && repo.paths.includes('.claude/CLAUDE.md');
      if (both) {
        diagnostics.push({
          severity: 'warn',
          message:
            'both ./CLAUDE.md and ./.claude/CLAUDE.md exist; the docs define no tie-break — both are mapped, order between them unresolved',
          locator: makeLocator(repo.root.id, 'CLAUDE.md'),
        });
      }
      for (const path of repo.paths) {
        const name = posixBasename(path);
        const dir = posixDirname(path);
        if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') {
          const isDotClaudeProject = path === '.claude/CLAUDE.md';
          const scopeDir = isDotClaudeProject ? '' : dir;
          if (dir !== '' && !isDotClaudeProject && /(^|\/)\.claude(\/|$)/.test(dir)) continue;
          memoryTargets.push({
            rootListing: repo,
            path,
            scopeDir,
            userScope: false,
            rank: 1000 + dirDepth(scopeDir) * 10 + (name === 'CLAUDE.local.md' ? 1 : 0),
            // Below-CWD files load on access; the split versus the launch
            // chain is scenario-dependent, so scope carries the directory
            // and the cascade decides using the scenario CWD.
            belowCwd: scopeDir !== '',
          });
        }
        if (/^\.claude\/rules\/.+\.md$/.test(path)) {
          memoryTargets.push({
            rootListing: repo,
            path,
            scopeDir: '',
            userScope: false,
            rank: 1005,
            belowCwd: false,
          });
        }
      }
    }

    for (const target of memoryTargets) {
      const rootId = target.rootListing.root.id;
      const content = await ctx.read(rootId, target.path);
      if (content === null) continue;

      let convention = 'claude-code/memory';
      const effectiveTarget = target;
      let text = content;
      // Project rules with `paths` frontmatter are path-scoped.
      if (target.path.startsWith('.claude/rules/')) {
        convention = 'claude-code/rules';
        const frontmatter = parseFrontmatter(content);
        if (frontmatter.present && 'error' in frontmatter) {
          diagnostics.push({
            severity: 'warn',
            message: `rule frontmatter unreadable (${frontmatter.error}); activation unresolved`,
            locator: makeLocator(rootId, target.path),
          });
          const charged: ContentProjection = {
            kind: 'unresolved',
            text: '',
            tokens: ctx.estimate(''),
          };
          emitForProfiles(rootId, target.path, 'markdown', (profile) => ({
            ...memoryBinding(profile, effectiveTarget, convention, charged),
            scope: { kind: 'unresolved', reason: 'malformed rule frontmatter' },
            activation: 'unresolved',
            cadence: 'unresolved',
          }), target.userScope ? ['claude-local'] : ['claude-local', 'claude-cloud']);
          continue;
        }
        const paths = frontmatter.present ? stringListField(frontmatter, 'paths') : undefined;
        text = frontmatter.present && !('error' in frontmatter) ? frontmatter.body : content;
        if (paths !== undefined) {
          const stripped = stripBlockComments(text);
          const charged: ContentProjection = {
            kind: 'comment-stripped',
            text: stripped,
            tokens: ctx.estimate(stripped),
          };
          emitForProfiles(rootId, target.path, 'markdown', (profile) => ({
            ...memoryBinding(profile, effectiveTarget, convention, charged),
            scope: { kind: 'glob', globs: paths },
            activation: 'on-path-access',
            cadence: 'once-on-trigger',
          }), target.userScope ? ['claude-local'] : ['claude-local', 'claude-cloud']);
          continue;
        }
      }

      const stripped = stripBlockComments(text);
      const charged: ContentProjection = {
        kind: 'comment-stripped',
        text: stripped,
        tokens: ctx.estimate(stripped),
      };
      const profiles: readonly SessionProfileId[] = target.userScope
        ? ['claude-local']
        : ['claude-local', 'claude-cloud'];
      const bothProjectLocations =
        !target.userScope &&
        (target.path === 'CLAUDE.md' || target.path === '.claude/CLAUDE.md') &&
        target.rootListing.paths.includes('CLAUDE.md') &&
        target.rootListing.paths.includes('.claude/CLAUDE.md');
      emitForProfiles(
        rootId,
        target.path,
        'markdown',
        (profile) => {
          const binding = memoryBinding(profile, effectiveTarget, convention, charged);
          // Both project memory locations exist: the docs define no
          // tie-break, so the order between them stays unresolved.
          return bothProjectLocations
            ? {
                ...binding,
                order: {
                  kind: 'unresolved',
                  reason: 'both ./CLAUDE.md and ./.claude/CLAUDE.md exist; tie-break undocumented',
                },
              }
            : binding;
        },
        profiles,
      );

      // ---- @import expansion, depth-limited, containment-checked ----
      await expandImports(
        ctx,
        target,
        content,
        1,
        new Set([makeLocator(rootId, target.path)]),
        bindings,
        diagnostics,
        profiles,
      );
    }

    // ---- auto memory (explicitly supplied directory only) ----
    const autoMemory = ctx.config.claudeAutoMemoryDir;
    if (autoMemory !== undefined) {
      const [rootId, dir] = splitRootRef(autoMemory);
      const listing = ctx.listings.find((entry) => entry.root.id === rootId);
      const indexPath = `${dir}/MEMORY.md`;
      if (listing?.paths.includes(indexPath)) {
        const content = await ctx.read(rootId, indexPath);
        if (content !== null) {
          const projected = memoryIndexPrefix(stripMemoryFrontmatter(stripBlockComments(content)));
          bindings.push({
            rootId,
            path: indexPath,
            contentKind: 'markdown',
            binding: {
              tool: 'claude-code',
              profile: 'claude-local',
              convention: 'claude-code/auto-memory-index',
              scope: { kind: 'always' },
              activation: 'session-start',
              cadence: 'per-session',
              charged: {
                kind: 'prefix',
                limit: { unit: 'lines', value: MEMORY_INDEX_MAX_LINES },
                text: projected,
                tokens: ctx.estimate(projected),
              },
              order: { kind: 'ordered', rule: 'auto memory loads with startup context', rank: 500 },
              conflict: 'later-overrides',
              semantics: MEMORY_VERIFIED,
            },
          });
        }
        for (const path of listing.paths) {
          if (!path.startsWith(`${dir}/`) || path === indexPath || !path.endsWith('.md')) continue;
          const content = await ctx.read(rootId, path);
          if (content === null) continue;
          bindings.push({
            rootId,
            path,
            contentKind: 'markdown',
            binding: {
              tool: 'claude-code',
              profile: 'claude-local',
              convention: 'claude-code/auto-memory-topic',
              scope: { kind: 'always' },
              activation: 'on-demand-resource',
              cadence: 'once-on-trigger',
              charged: { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
              order: { kind: 'unordered', rule: 'topic files load on demand' },
              conflict: 'later-overrides',
              semantics: MEMORY_VERIFIED,
            },
          });
        }
      } else {
        diagnostics.push({
          severity: 'warn',
          message: `configured auto-memory index ${autoMemory}/MEMORY.md not found`,
        });
      }
    }

    // ---- skills and commands ----
    const skillRoots: readonly { listing: RootListing; dir: string; profiles: readonly SessionProfileId[]; rankBase: number }[] = [
      ...users.map((listing) => ({
        listing,
        dir: '.claude/skills',
        profiles: ['claude-local'] as const,
        rankBase: 100,
      })),
      ...(repo === undefined
        ? []
        : [
            {
              listing: repo,
              dir: '.claude/skills',
              profiles: ['claude-local', 'claude-cloud'] as const,
              rankBase: 1100,
            },
          ]),
    ];
    for (const { listing, dir, profiles } of skillRoots) {
      for (const skill of findSkillDirs(listing.paths, dir)) {
        const content = await ctx.read(listing.root.id, skill.skillFile);
        if (content === null) continue;
        emitSkill(ctx, listing.root.id, skill, content, profiles, bindings, diagnostics);
      }
      // Nested project skills load on access; map them subtree-scoped.
      if (listing.root.kind === 'repository') {
        const nestedDirs = new Set<string>();
        for (const path of listing.paths) {
          const match = /^(.+)\/\.claude\/skills\//.exec(path);
          if (match?.[1] !== undefined) nestedDirs.add(match[1]);
        }
        for (const base of [...nestedDirs].sort()) {
          for (const skill of findSkillDirs(listing.paths, `${base}/.claude/skills`)) {
            const content = await ctx.read(listing.root.id, skill.skillFile);
            if (content === null) continue;
            emitSkill(ctx, listing.root.id, skill, content, profiles, bindings, diagnostics, {
              kind: 'directory-subtree',
              directory: base,
              via: 'touched',
            });
          }
        }
      }
    }
    const commandRoots = [
      ...users.map((listing) => ({ listing, profiles: ['claude-local'] as const })),
      ...(repo === undefined
        ? []
        : [{ listing: repo, profiles: ['claude-local', 'claude-cloud'] as const }]),
    ];
    for (const { listing, profiles } of commandRoots) {
      for (const path of listing.paths) {
        if (!/^\.claude\/commands\/[^/]+\.md$/.test(path)) continue;
        const content = await ctx.read(listing.root.id, path);
        if (content === null) continue;
        const frontmatter = parseFrontmatter(content);
        const description =
          frontmatter.present && !('error' in frontmatter)
            ? stringField(frontmatter, 'description')
            : undefined;
        const metadataText =
          description === undefined
            ? ''
            : `${posixBasename(path).replace(/\.md$/, '')}: ${description}`;
        for (const profile of profiles) {
          if (metadataText !== '') {
            bindings.push({
              rootId: listing.root.id,
              path,
              contentKind: 'skill',
              binding: {
                tool: 'claude-code',
                profile,
                convention: 'claude-code/command-metadata',
                scope: { kind: 'always' },
                activation: 'session-start',
                cadence: 'per-session',
                charged: {
                  kind: 'frontmatter-fields',
                  fields: ['description'],
                  text: metadataText,
                  tokens: ctx.estimate(metadataText),
                },
                order: { kind: 'unordered', rule: 'command listing order is not documented' },
                conflict: 'combined-no-precedence',
                semantics: SKILLS_VERIFIED,
              },
            });
          }
          bindings.push({
            rootId: listing.root.id,
            path,
            contentKind: 'skill',
            binding: {
              tool: 'claude-code',
              profile,
              convention: 'claude-code/command-body',
              scope: { kind: 'always' },
              activation: 'on-invocation',
              cadence: 'once-on-trigger',
              charged: { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
              order: { kind: 'unordered', rule: 'loads at invocation time' },
              conflict: 'combined-no-precedence',
              semantics: SKILLS_VERIFIED,
            },
          });
        }
      }
    }

    return { bindings, diagnostics };
  },
};

function splitRootRef(ref: string): [string, string] {
  const colon = ref.indexOf(':');
  return colon === -1 ? ['user', ref] : [ref.slice(0, colon), ref.slice(colon + 1)];
}

function stripMemoryFrontmatter(content: string): string {
  const frontmatter = parseFrontmatter(content);
  return frontmatter.present && !('error' in frontmatter) ? frontmatter.body : content;
}

function memoryIndexPrefix(content: string): string {
  const lines = content.split("\n").slice(0, MEMORY_INDEX_MAX_LINES);
  let text = lines.join("\n");
  // 25 KB cap, whichever comes first.
  const encoder = new TextEncoder();
  while (encoder.encode(text).length > MEMORY_INDEX_MAX_BYTES) {
    const cut = text.split("\n");
    cut.pop();
    text = cut.join("\n");
  }
  return text;
}

function emitSkill(
  ctx: AdapterContext,
  rootId: string,
  skill: { readonly dir: string; readonly skillFile: string; readonly resources: readonly string[] },
  content: string,
  profiles: readonly SessionProfileId[],
  bindings: AdapterBinding[],
  diagnostics: CorpusDiagnostic[],
  scope: InstructionBinding['scope'] = { kind: 'always' },
): void {
  const parsed = parseSkill(skill.skillFile, content);
  if (!parsed.valid) {
    diagnostics.push({
      severity: 'warn',
      message: `invalid SKILL.md (${parsed.problems.join('; ')}); loading semantics unresolved`,
      locator: makeLocator(rootId, skill.skillFile),
    });
  }
  const spec: SemanticsEvidence = parsed.valid
    ? { status: 'verified', source: AGENT_SKILLS_SOURCE, verifiedAt: AGENT_SKILLS_VERIFIED_AT }
    : { status: 'unverified', reason: 'SKILL.md fails spec validation', source: AGENT_SKILLS_SOURCE };
  for (const profile of profiles) {
    bindings.push({
      rootId,
      path: skill.skillFile,
      contentKind: 'skill',
      binding: {
        tool: 'claude-code',
        profile,
        convention: 'claude-code/skill-metadata',
        scope,
        activation: parsed.valid ? 'session-start' : 'unresolved',
        cadence: 'per-session',
        charged: {
          kind: 'frontmatter-fields',
          fields: ['name', 'description'],
          text: parsed.metadataText,
          tokens: ctx.estimate(parsed.metadataText),
        },
        order: { kind: 'unordered', rule: 'skill listing order is not documented' },
        conflict: 'combined-no-precedence',
        semantics: spec,
      },
    });
    bindings.push({
      rootId,
      path: skill.skillFile,
      contentKind: 'skill',
      binding: {
        tool: 'claude-code',
        profile,
        convention: 'claude-code/skill-body',
        scope,
        activation: parsed.valid ? 'model-decision' : 'unresolved',
        cadence: 'once-on-trigger',
        charged: { kind: 'body', text: parsed.body, tokens: ctx.estimate(parsed.body) },
        order: { kind: 'unordered', rule: 'loads at activation time' },
        conflict: 'combined-no-precedence',
        semantics: spec,
      },
    });
    for (const resource of skill.resources) {
      bindings.push({
        rootId,
        path: resource,
        contentKind: 'unknown',
        binding: {
          tool: 'claude-code',
          profile,
          convention: 'claude-code/skill-resource',
          scope,
          activation: 'on-demand-resource',
          cadence: 'once-on-trigger',
          charged: { kind: 'none', text: '', tokens: ctx.estimate('') },
          order: { kind: 'unordered', rule: 'resources load on demand' },
          conflict: 'combined-no-precedence',
          semantics: spec,
        },
      });
    }
  }
}

async function expandImports(
  ctx: AdapterContext,
  importer: MemoryTarget,
  content: string,
  depth: number,
  seen: Set<string>,
  bindings: AdapterBinding[],
  diagnostics: CorpusDiagnostic[],
  profiles: readonly SessionProfileId[],
): Promise<void> {
  if (depth > IMPORT_MAX_DEPTH) return;
  const rootId = importer.rootListing.root.id;
  for (const ref of findImports(content)) {
    const resolved = resolveImportRef(ctx, importer, ref);
    if (resolved.kind === 'external') {
      const locator = makeLocator(rootId, importer.path);
      if (importer.userScope) {
        diagnostics.push({
          severity: 'info',
          message: `user-scope import @${ref} resolves outside authorized roots; content unavailable to the corpus`,
          locator,
        });
      } else {
        diagnostics.push({
          severity: 'warn',
          message: `project-scope import @${ref} resolves outside the repository; approval-gated and unresolved`,
          locator,
        });
      }
      continue;
    }
    const { targetRootId, targetPath, external } = resolved;
    const targetLocator = makeLocator(targetRootId, targetPath);
    if (seen.has(targetLocator)) continue;
    seen.add(targetLocator);
    const imported = await ctx.read(targetRootId, targetPath);
    if (imported === null) {
      diagnostics.push({
        severity: 'warn',
        message: `import @${ref} from ${makeLocator(rootId, importer.path)} could not be read`,
        locator: targetLocator,
      });
      continue;
    }
    const stripped = stripBlockComments(imported);
    const approvalGated = external && !importer.userScope;
    // Cloud sessions clone the repository only; an import target on a user
    // root does not exist for them.
    const targetProfiles =
      resolved.rootListing.root.kind === 'user'
        ? profiles.filter((profile) => profile !== 'claude-cloud')
        : profiles;
    for (const profile of targetProfiles) {
      bindings.push({
        rootId: targetRootId,
        path: targetPath,
        contentKind: 'markdown',
        binding: {
          tool: 'claude-code',
          profile,
          convention: approvalGated ? 'claude-code/import-external' : 'claude-code/import',
          scope: approvalGated
            ? {
                kind: 'unresolved',
                reason:
                  'external import in project scope is approval-gated; list the locator in scenario.acceptedExternalImports to confirm',
              }
            : importer.scopeDir === ''
              ? { kind: 'root' }
              : { kind: 'directory-subtree', directory: importer.scopeDir, via: importer.belowCwd ? 'cwd-or-touched' : 'cwd' },
          activation: approvalGated ? 'unresolved' : importer.belowCwd ? 'on-path-access' : 'session-start',
          cadence: importer.belowCwd ? 'once-on-trigger' : 'per-session',
          charged: { kind: 'imported', text: stripped, tokens: ctx.estimate(stripped) },
          order: {
            kind: 'ordered',
            rule: 'imports expand in place of the referencing file at launch',
            rank: importer.rank,
          },
          conflict: 'later-overrides',
          semantics: MEMORY_VERIFIED,
        },
      });
    }
    await expandImports(
      ctx,
      { ...importer, path: targetPath, rootListing: resolved.rootListing },
      imported,
      depth + 1,
      seen,
      bindings,
      diagnostics,
      profiles,
    );
  }
}

type ImportResolution =
  | { readonly kind: 'external' }
  | {
      readonly kind: 'resolved';
      readonly targetRootId: string;
      readonly targetPath: string;
      readonly rootListing: RootListing;
      /** True when the target left the importer's own root. */
      readonly external: boolean;
    };

function resolveImportRef(
  ctx: AdapterContext,
  importer: MemoryTarget,
  ref: string,
): ImportResolution {
  // `~/x` maps to the first authorized user root; absolute paths are
  // external unless a root contains them (roots are compared by listing
  // membership, since the corpus never stores absolute paths).
  if (ref.startsWith('~/')) {
    const user = ctx.listings.find((listing) => listing.root.kind === 'user');
    if (user === undefined) return { kind: 'external' };
    const path = normalizeRelative(ref.slice(2));
    if (path === null) return { kind: 'external' };
    return {
      kind: 'resolved',
      targetRootId: user.root.id,
      targetPath: path,
      rootListing: user,
      external: importer.rootListing.root.id !== user.root.id,
    };
  }
  if (ref.startsWith('/')) return { kind: 'external' };
  const base = posixDirname(importer.path);
  const combined = normalizeRelative(base === '' ? ref : `${base}/${ref}`);
  if (combined === null) return { kind: 'external' };
  return {
    kind: 'resolved',
    targetRootId: importer.rootListing.root.id,
    targetPath: combined,
    rootListing: importer.rootListing,
    external: false,
  };
}

/** Collapse `.`/`..` segments; null when the path escapes the root. */
function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}
