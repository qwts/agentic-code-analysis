// The comparison model of this check (ACA-0013): every judged file is either
// `new` (head snapshot only) or `legacy` (base and head snapshots), resolved
// against the merge-base once per run with rename detection. The judge sees
// snapshots; git stays in this module.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../core/config.ts';
import { buildImporterIndex, CODE_EXT, importedBy, importsOf, readContents } from './derive.ts';

export interface Snapshot {
  path: string;
  content: string;
  imports: string[];
  importedBy: string[];
}

export type Comparison =
  | { kind: 'new'; head: Snapshot; growth: string }
  | { kind: 'legacy'; base: Snapshot; head: Snapshot; growth: string };

/** Unavailable evidence (unreadable head, inconsistent base snapshot) is a
 * per-file degradation, never inferred as "new" and never cached. */
export type Prepared = { ok: true; comparison: Comparison } | { ok: false; note: string };

interface ChangeStatus {
  added: Set<string>;
  deleted: Set<string>;
  modified: Set<string>;
  /** head path → base path, for renames. A copy/extraction stays `new`. */
  renamedFrom: Map<string, string>;
}

function git(repoRoot: string, args: string[]): string {
  // stderr piped, not inherited: findings-only output (D4) must not carry
  // git's noise.
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files']).split('\n').filter(Boolean);
}

/** `-z --name-status` entries: STATUS␀path␀ for A/M/D/T, STATUS␀old␀new␀ for R. */
function changeStatus(repoRoot: string, mergeBase: string): ChangeStatus {
  const status: ChangeStatus = { added: new Set(), deleted: new Set(), modified: new Set(), renamedFrom: new Map() };
  const tokens = git(repoRoot, ['diff', '--name-status', '-z', '--find-renames', mergeBase]).split('\0');
  for (let i = 0; i < tokens.length - 1; ) {
    const code = tokens[i]![0];
    if (code === 'R') {
      status.renamedFrom.set(tokens[i + 2]!, tokens[i + 1]!);
      i += 3;
    } else {
      const path = tokens[i + 1]!;
      if (code === 'A') status.added.add(path);
      else if (code === 'D') status.deleted.add(path);
      else status.modified.add(path);
      i += 2;
    }
  }
  return status;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function growthLine(base: string | undefined, head: string): string {
  const lines = lineCount(head);
  if (base === undefined) return `new file, ${lines} lines`;
  const before = lineCount(base);
  if (before === lines) return `unchanged at ${lines} lines`;
  return `${before < lines ? 'grew' : 'shrank'} from ${before} to ${lines} lines`;
}

/**
 * One merge-base resolution, one rename-aware diff, one read of the head
 * tree; the base tree is reconstructed from the head contents plus the
 * changed paths, so modified, deleted, and renamed importers are represented
 * without one git process per repository file.
 */
export function buildComparisons(repoRoot: string, baseRef: string, files: string[]): Map<string, Prepared> {
  let mergeBase: string;
  try {
    mergeBase = git(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    // Run-level configuration error, never per-file "new" (ACA-0013).
    throw new ConfigError(`cannot resolve merge-base of ${baseRef} and HEAD; fetch the base ref or pass --base`);
  }
  const status = changeStatus(repoRoot, mergeBase);
  const showBase = (path: string): string | undefined => {
    try {
      return git(repoRoot, ['show', `${mergeBase}:${path}`]);
    } catch {
      return undefined;
    }
  };

  const headFiles = repoFiles(repoRoot);
  const headContents = readContents(repoRoot, headFiles);
  const headIndex = buildImporterIndex(headContents);

  const baseFiles = new Set(headFiles);
  const baseContents = new Map(headContents);
  for (const path of status.added) {
    baseFiles.delete(path);
    baseContents.delete(path);
  }
  for (const [headPath, basePath] of status.renamedFrom) {
    baseFiles.delete(headPath);
    baseContents.delete(headPath);
    baseFiles.add(basePath);
  }
  for (const path of [...status.deleted, ...status.modified, ...status.renamedFrom.values()]) {
    baseFiles.add(path);
    // The base graph indexes code files only, like the head graph — a changed
    // doc with import-looking text must not become a phantom base importer
    // (Codex review, PR #29).
    if (!CODE_EXT.test(path)) continue;
    const content = showBase(path);
    if (content === undefined) baseContents.delete(path);
    else baseContents.set(path, content);
  }
  const baseIndex = buildImporterIndex(baseContents);

  const prepared = new Map<string, Prepared>();
  for (const file of files) {
    let headContent: string;
    try {
      headContent = headContents.get(file) ?? readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      prepared.set(file, { ok: false, note: 'unreadable' });
      continue;
    }
    const head: Snapshot = { path: file, content: headContent, imports: importsOf(file, headContent), importedBy: importedBy(headIndex, file) };
    const basePath = status.renamedFrom.get(file) ?? file;
    if (status.added.has(file) || !baseFiles.has(basePath)) {
      prepared.set(file, { ok: true, comparison: { kind: 'new', head, growth: growthLine(undefined, headContent) } });
      continue;
    }
    // Unchanged legacy content is identical at both ends by definition; only
    // changed paths cost a git show (already read for the base graph or here).
    const baseContent = status.modified.has(basePath) || status.renamedFrom.has(file) ? (baseContents.get(basePath) ?? showBase(basePath)) : headContent;
    if (baseContent === undefined) {
      prepared.set(file, { ok: false, note: 'base snapshot unavailable' });
      continue;
    }
    const base: Snapshot = { path: basePath, content: baseContent, imports: importsOf(basePath, baseContent), importedBy: importedBy(baseIndex, basePath) };
    prepared.set(file, { ok: true, comparison: { kind: 'legacy', base, head, growth: growthLine(baseContent, headContent) } });
  }
  return prepared;
}
