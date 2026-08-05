// Claude Code memory and rules: root memory loads at session start,
// nested-directory memory loads on access (so it is conditional, not
// baseline), `@path` imports expand recursively inside the authorized root,
// and `.claude/rules/**/*.md` activates always or per its `paths` front
// matter. A user-origin root (an explicitly authorized `~/.claude`) carries
// the same shapes without the `.claude/` prefix.
// Source: https://code.claude.com/docs/en/memory (verified 2026-08-04).
import { globList, parseFrontmatter } from '../frontmatter.ts';
import { dirOf, fragment, unverified, verified, type CandidateBinding, type Estimate, type InstructionConvention } from '../adapter.ts';
import type { Activation, Fragment, Origin } from '../model.ts';
import type { TreeSnapshot } from '../tree.ts';

const DOCS = 'https://code.claude.com/docs/en/memory';
const IMPORT = /(?:^|\s)@([A-Za-z0-9_.~][A-Za-z0-9_./-]*)/g;
const MAX_IMPORT_DEPTH = 5;

export const claudeConvention: InstructionConvention = {
  id: 'claude-memory',
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
    return [...memoryBindings(snapshot, origin, estimate), ...ruleBindings(snapshot, origin, estimate)];
  },
};

function isMemoryPath(path: string, origin: Origin): boolean {
  if (path === 'CLAUDE.md' || path === 'CLAUDE.local.md') return true;
  if (origin === 'repository' && path === '.claude/CLAUDE.md') return true;
  // Nested project memory: <dir>/CLAUDE.md, excluding instruction-tool dirs.
  return origin === 'repository' && path.endsWith('/CLAUDE.md') && !path.startsWith('.claude/');
}

function memoryBindings(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
  const found: CandidateBinding[] = [];
  for (const path of snapshot.paths) {
    if (!isMemoryPath(path, origin)) continue;
    const content = snapshot.content(path);
    if (content === undefined) continue;
    const scopeDir = path.endsWith('/CLAUDE.md') && path !== '.claude/CLAUDE.md' ? dirOf(path) : '';
    const nested = scopeDir !== '';
    const activation: Activation = nested ? 'path' : 'always';
    const diagnostics: string[] = [];
    const fragments: Fragment[] = [fragment('body', activation, content, estimate)];
    expandImports(snapshot, path, content, activation, estimate, fragments, diagnostics, new Set([path]), 0);
    found.push({
      path,
      binding: { tool: 'claude-code', convention: 'claude-memory', scopeDir, activation, fragments, semantics: verified(DOCS) },
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }
  return found;
}

function expandImports(
  snapshot: TreeSnapshot,
  fromPath: string,
  content: string,
  activation: Activation,
  estimate: Estimate,
  fragments: Fragment[],
  diagnostics: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth >= MAX_IMPORT_DEPTH) {
    diagnostics.push(`import depth limit reached at ${fromPath}`);
    return;
  }
  for (const match of content.matchAll(IMPORT)) {
    const target = normalizeImport(dirOf(fromPath), match[1]!);
    if (target === undefined) {
      diagnostics.push(`import escapes authorized root, unresolved: @${match[1]} in ${fromPath}`);
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    const imported = snapshot.content(target);
    if (imported === undefined) {
      diagnostics.push(`import not found in authorized root: @${match[1]} in ${fromPath}`);
      continue;
    }
    fragments.push(fragment('import', activation, imported, estimate));
    expandImports(snapshot, target, imported, activation, estimate, fragments, diagnostics, seen, depth + 1);
  }
}

/** Resolve an @import against the importing file's directory, staying inside
 * the root: home/absolute references and '..' escapes become undefined,
 * never a read. */
function normalizeImport(fromDir: string, spec: string): string | undefined {
  if (spec.startsWith('~') || spec.startsWith('/')) return undefined;
  const parts = (fromDir === '' ? [] : fromDir.split('/')).concat(spec.split('/'));
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join('/');
}

function ruleBindings(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[] {
  const prefix = origin === 'repository' ? '.claude/rules/' : 'rules/';
  const found: CandidateBinding[] = [];
  for (const path of snapshot.paths) {
    if (!path.startsWith(prefix) || !path.endsWith('.md')) continue;
    const content = snapshot.content(path);
    if (content === undefined) continue;
    const parsed = parseFrontmatter(content);
    if (parsed.error !== undefined && parsed.error !== 'no front matter') {
      found.push({
        path,
        binding: {
          tool: 'claude-code',
          convention: 'claude-rules',
          scopeDir: '',
          activation: 'unknown',
          fragments: [fragment('body', 'unknown', content, estimate)],
          semantics: unverified(`front matter unsupported: ${parsed.error}`),
        },
      });
      continue;
    }
    const globs = globList(parsed.fields, 'paths');
    const activation: Activation = globs !== undefined ? 'path' : 'always';
    found.push({
      path,
      binding: {
        tool: 'claude-code',
        convention: 'claude-rules',
        scopeDir: '',
        ...(globs !== undefined ? { pathGlobs: globs } : {}),
        activation,
        fragments: [fragment('body', activation, parsed.error === 'no front matter' ? content : parsed.body, estimate)],
        semantics: verified(DOCS),
      },
    });
  }
  return found;
}
