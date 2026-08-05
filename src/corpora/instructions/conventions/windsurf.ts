// Windsurf/Devin conventions (docs.devin.ai desktop/cascade memories,
// agents-md, and skills pages, verified 2026-08-05). Profiles:
// `cascade-legacy` and `devin-local` share the file conventions; legacy
// Cascade additionally persists internal memories that are not
// filesystem-observable (documented gap). Rules: .devin/rules/*.md
// preferred, .windsurf/rules/*.md is the fallback location and is shadowed
// when .devin/rules exists at the same level; 12k chars/file workspace cap,
// 6k global. Root AGENTS.md is always-on every message; nested AGENTS.md
// auto-scopes via `<dir>/**`. Legacy .windsurfrules: found, unverified.

import type {
  AdapterBinding,
  AdapterContext,
  AdapterResult,
  ContentProjection,
  ConventionAdapter,
  CorpusDiagnostic,
  InstructionBinding,
  SemanticsEvidence,
  SessionProfileId,
} from '../model.ts';
import { parseFrontmatter, stringField } from '../frontmatter.ts';
import { makeLocator, posixBasename, posixDirname } from '../paths.ts';
import {
  AGENT_SKILLS_SOURCE,
  AGENT_SKILLS_VERIFIED_AT,
  findSkillDirs,
  parseSkill,
} from './agent-skills.ts';

const MEMORIES_SOURCE = 'https://docs.devin.ai/desktop/cascade/memories';
const AGENTS_SOURCE = 'https://docs.devin.ai/desktop/cascade/agents-md';
const SKILLS_SOURCE = 'https://docs.devin.ai/desktop/cascade/skills';
const VERIFIED_AT = '2026-08-05';

const WORKSPACE_RULE_CHAR_CAP = 12_000;
const GLOBAL_RULE_CHAR_CAP = 6_000;

const PROFILES: readonly SessionProfileId[] = ['cascade-legacy', 'devin-local'];

function verified(source: string): SemanticsEvidence {
  return { status: 'verified', source, verifiedAt: VERIFIED_AT };
}

function cappedProjection(
  ctx: AdapterContext,
  text: string,
  cap: number,
): ContentProjection {
  if (text.length <= cap) {
    return { kind: 'whole-file', text, tokens: ctx.estimate(text) };
  }
  const prefix = text.slice(0, cap);
  return {
    kind: 'prefix',
    limit: { unit: 'chars', value: cap },
    text: prefix,
    tokens: ctx.estimate(prefix),
  };
}

function ruleBinding(
  profile: SessionProfileId,
  convention: string,
  scope: InstructionBinding['scope'],
  activation: InstructionBinding['activation'],
  cadence: InstructionBinding['cadence'],
  charged: ContentProjection,
  source: string,
  rank: number,
): InstructionBinding {
  return {
    tool: 'windsurf-devin',
    profile,
    convention,
    scope,
    activation,
    cadence,
    charged,
    order: {
      kind: 'ordered',
      rule: '.devin/rules before .windsurf/rules; global rules first',
      rank,
    },
    conflict: 'unresolved',
    semantics: verified(source),
  };
}

export const windsurfAdapter: ConventionAdapter = {
  id: 'windsurf-devin',
  async interpret(ctx: AdapterContext): Promise<AdapterResult> {
    const bindings: AdapterBinding[] = [];
    const diagnostics: CorpusDiagnostic[] = [];
    const repo = ctx.listings.find((listing) => listing.root.kind === 'repository');
    const users = ctx.listings.filter((listing) => listing.root.kind === 'user');

    // ---- global rules (user root) ----
    for (const user of users) {
      const globalRules = '.codeium/windsurf/memories/global_rules.md';
      if (user.paths.includes(globalRules)) {
        const content = await ctx.read(user.root.id, globalRules);
        if (content !== null) {
          for (const profile of PROFILES) {
            bindings.push({
              rootId: user.root.id,
              path: globalRules,
              contentKind: 'markdown',
              binding: ruleBinding(
                profile,
                'windsurf/global-rules',
                { kind: 'always' },
                'session-start',
                'per-message',
                cappedProjection(ctx, content, GLOBAL_RULE_CHAR_CAP),
                MEMORIES_SOURCE,
                0,
              ),
            });
          }
        }
      }
      // Global skills, plus the cross-agent user locations.
      for (const skillsDir of ['.codeium/windsurf/skills', '.agents/skills', '.claude/skills']) {
        for (const skill of findSkillDirs(user.paths, skillsDir)) {
          const content = await ctx.read(user.root.id, skill.skillFile);
          if (content === null) continue;
          emitSkill(ctx, user.root.id, skill, content, bindings, diagnostics);
        }
      }
    }

    if (repo === undefined) return { bindings, diagnostics };

    // ---- workspace rules, .devin preferred over .windsurf per level ----
    const ruleDirLevels = new Map<string, { devin: string[]; windsurf: string[] }>();
    for (const path of repo.paths) {
      const match = /^(?:(.*)\/)?\.(devin|windsurf)\/rules\/[^/]+\.md$/.exec(path);
      if (match === null) continue;
      const base = match[1] ?? '';
      const level = ruleDirLevels.get(base) ?? { devin: [], windsurf: [] };
      if (match[2] === 'devin') level.devin.push(path);
      else level.windsurf.push(path);
      ruleDirLevels.set(base, level);
    }
    for (const [base, level] of [...ruleDirLevels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const shadowed = level.devin.length > 0 && level.windsurf.length > 0;
      if (shadowed) {
        for (const path of level.windsurf) {
          diagnostics.push({
            severity: 'info',
            message: '.windsurf/rules is the fallback location; shadowed by .devin/rules at this level',
            locator: makeLocator(repo.root.id, path),
          });
        }
      }
      const active = level.devin.length > 0 ? level.devin : level.windsurf;
      for (const path of active.sort()) {
        const content = await ctx.read(repo.root.id, path);
        if (content === null) continue;
        await emitWorkspaceRule(ctx, repo.root.id, base, path, content, bindings, diagnostics);
      }
    }

    // ---- AGENTS.md (case-insensitive) ----
    for (const path of repo.paths) {
      const name = posixBasename(path);
      if (name !== 'AGENTS.md' && name !== 'agents.md') continue;
      const dir = posixDirname(path);
      const content = await ctx.read(repo.root.id, path);
      if (content === null) continue;
      for (const profile of PROFILES) {
        bindings.push({
          rootId: repo.root.id,
          path,
          contentKind: 'markdown',
          binding: {
            tool: 'windsurf-devin',
            profile,
            convention: dir === '' ? 'windsurf/agents-md-root' : 'windsurf/agents-md-nested',
            scope:
              dir === ''
                ? { kind: 'root' }
                : { kind: 'glob', globs: [`${dir}/**`] },
            activation: dir === '' ? 'session-start' : 'on-path-access',
            cadence: dir === '' ? 'per-message' : 'once-on-trigger',
            charged: { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
            order: {
              kind: 'ordered',
              rule: 'root AGENTS.md always on; nested files attach by generated <dir>/** glob',
              rank: 100,
            },
            conflict: 'unresolved',
            semantics: verified(AGENTS_SOURCE),
          },
        });
      }
    }

    // ---- legacy .windsurfrules ----
    if (repo.paths.includes('.windsurfrules')) {
      const content = await ctx.read(repo.root.id, '.windsurfrules');
      if (content !== null) {
        diagnostics.push({
          severity: 'warn',
          message:
            'legacy .windsurfrules found; still read per current docs, but activation/precedence is not fully defined',
          locator: makeLocator(repo.root.id, '.windsurfrules'),
        });
        for (const profile of PROFILES) {
          bindings.push({
            rootId: repo.root.id,
            path: '.windsurfrules',
            contentKind: 'markdown',
            binding: {
              tool: 'windsurf-devin',
              profile,
              convention: 'windsurf/legacy-windsurfrules',
              scope: { kind: 'unresolved', reason: 'legacy file; activation not fully documented' },
              activation: 'unresolved',
              cadence: 'unresolved',
              charged: { kind: 'whole-file', text: content, tokens: ctx.estimate(content) },
              order: { kind: 'unresolved', reason: 'legacy file; precedence not fully documented' },
              conflict: 'unresolved',
              semantics: {
                status: 'legacy',
                reason: 'still read, but current docs do not fully define activation/precedence',
                source: MEMORIES_SOURCE,
              },
            },
          });
        }
      }
    }

    // ---- workspace skills, incl. cross-agent locations ----
    for (const skillsDir of ['.windsurf/skills', '.agents/skills', '.claude/skills']) {
      for (const skill of findSkillDirs(repo.paths, skillsDir)) {
        const content = await ctx.read(repo.root.id, skill.skillFile);
        if (content === null) continue;
        emitSkill(ctx, repo.root.id, skill, content, bindings, diagnostics);
      }
    }

    return { bindings, diagnostics };
  },
};

async function emitWorkspaceRule(
  ctx: AdapterContext,
  rootId: string,
  base: string,
  path: string,
  content: string,
  bindings: AdapterBinding[],
  diagnostics: CorpusDiagnostic[],
): Promise<void> {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter.present && 'error' in frontmatter) {
    diagnostics.push({
      severity: 'warn',
      message: `rule frontmatter unreadable (${frontmatter.error}); trigger unresolved`,
      locator: makeLocator(rootId, path),
    });
  }
  const trigger =
    frontmatter.present && !('error' in frontmatter)
      ? stringField(frontmatter, 'trigger')
      : undefined;
  const description =
    frontmatter.present && !('error' in frontmatter)
      ? stringField(frontmatter, 'description')
      : undefined;
  const globsField =
    frontmatter.present && !('error' in frontmatter)
      ? stringField(frontmatter, 'globs')
      : undefined;
  const body = frontmatter.present && !('error' in frontmatter) ? frontmatter.body : content;
  const charged = cappedProjection(ctx, body, WORKSPACE_RULE_CHAR_CAP);
  if (charged.kind === 'prefix') {
    diagnostics.push({
      severity: 'info',
      message: `workspace rule exceeds the ${WORKSPACE_RULE_CHAR_CAP}-character cap; charged as the documented prefix`,
      locator: makeLocator(rootId, path),
    });
  }
  const scopeBase: InstructionBinding['scope'] =
    base === ''
      ? { kind: 'always' }
      : { kind: 'directory-subtree', directory: base, via: 'touched' };

  for (const profile of PROFILES) {
    if (trigger === 'always_on') {
      bindings.push({
        rootId,
        path,
        contentKind: 'markdown',
        binding: ruleBinding(
          profile,
          'windsurf/rule-always-on',
          scopeBase,
          'session-start',
          'per-message',
          charged,
          MEMORIES_SOURCE,
          10,
        ),
      });
    } else if (trigger === 'model_decision') {
      const metadataText = description ?? '';
      bindings.push({
        rootId,
        path,
        contentKind: 'markdown',
        binding: ruleBinding(
          profile,
          'windsurf/rule-metadata',
          scopeBase,
          'session-start',
          'per-message',
          {
            kind: 'frontmatter-fields',
            fields: ['description'],
            text: metadataText,
            tokens: ctx.estimate(metadataText),
          },
          MEMORIES_SOURCE,
          10,
        ),
      });
      bindings.push({
        rootId,
        path,
        contentKind: 'markdown',
        binding: ruleBinding(
          profile,
          'windsurf/rule-model-decision',
          scopeBase,
          'model-decision',
          'once-on-trigger',
          charged,
          MEMORIES_SOURCE,
          10,
        ),
      });
    } else if (trigger === 'glob') {
      const globs =
        globsField === undefined
          ? undefined
          : globsField
              .split(',')
              .map((glob) => glob.trim())
              .filter((glob) => glob.length > 0)
              .map((glob) => (base === '' ? glob : `${base}/${glob}`));
      if (globs === undefined || globs.length === 0) {
        diagnostics.push({
          severity: 'warn',
          message: 'glob-triggered rule without a usable globs field; scope unresolved',
          locator: makeLocator(rootId, path),
        });
        bindings.push({
          rootId,
          path,
          contentKind: 'markdown',
          binding: ruleBinding(
            profile,
            'windsurf/rule-glob',
            { kind: 'unresolved', reason: 'glob trigger without globs' },
            'unresolved',
            'unresolved',
            charged,
            MEMORIES_SOURCE,
            10,
          ),
        });
      } else {
        bindings.push({
          rootId,
          path,
          contentKind: 'markdown',
          binding: ruleBinding(
            profile,
            'windsurf/rule-glob',
            { kind: 'glob', globs },
            'on-path-access',
            'once-on-trigger',
            charged,
            MEMORIES_SOURCE,
            10,
          ),
        });
      }
    } else if (trigger === 'manual') {
      bindings.push({
        rootId,
        path,
        contentKind: 'markdown',
        binding: ruleBinding(
          profile,
          'windsurf/rule-manual',
          scopeBase,
          'on-invocation',
          'once-on-trigger',
          charged,
          MEMORIES_SOURCE,
          10,
        ),
      });
    } else {
      // No documented default when `trigger` is missing or unknown.
      bindings.push({
        rootId,
        path,
        contentKind: 'markdown',
        binding: ruleBinding(
          profile,
          'windsurf/rule',
          { kind: 'unresolved', reason: 'missing/unknown trigger; no documented default' },
          'unresolved',
          'unresolved',
          charged,
          MEMORIES_SOURCE,
          10,
        ),
      });
    }
  }
  if (trigger === undefined) {
    diagnostics.push({
      severity: 'warn',
      message: 'rule has no `trigger` frontmatter; the docs define no default — activation unresolved',
      locator: makeLocator(rootId, path),
    });
  }
}

function emitSkill(
  ctx: AdapterContext,
  rootId: string,
  skill: { readonly dir: string; readonly skillFile: string; readonly resources: readonly string[] },
  content: string,
  bindings: AdapterBinding[],
  diagnostics: CorpusDiagnostic[],
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
    ? { status: 'verified', source: SKILLS_SOURCE, verifiedAt: AGENT_SKILLS_VERIFIED_AT }
    : { status: 'unverified', reason: 'SKILL.md fails spec validation', source: AGENT_SKILLS_SOURCE };
  for (const profile of PROFILES) {
    bindings.push({
      rootId,
      path: skill.skillFile,
      contentKind: 'skill',
      binding: {
        tool: 'windsurf-devin',
        profile,
        convention: 'windsurf/skill-metadata',
        scope: { kind: 'always' },
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
        tool: 'windsurf-devin',
        profile,
        convention: 'windsurf/skill-body',
        scope: { kind: 'always' },
        activation: parsed.valid ? 'model-decision' : 'unresolved',
        cadence: 'once-on-trigger',
        charged: { kind: 'body', text: parsed.body, tokens: ctx.estimate(parsed.body) },
        order: { kind: 'unordered', rule: 'loads at activation time' },
        conflict: 'combined-no-precedence',
        semantics: spec,
      },
    });
  }
}
