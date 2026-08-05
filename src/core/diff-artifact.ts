// The canonical diff artifact (ACA-0020 D3/D4): one representation of "the
// change", shared by every diff-scoped check. Two constructors — git
// (production: merge-base vs working tree, renames detected) and in-memory
// trees (pair fixtures, no git) — feed one renderer, so no diff check parses
// git output or invents a second diff format. The rendered judge payload
// prefixes context/added lines with their HEAD line numbers (the judge
// anchors to numbers it can see); the payload is bounded, and files that
// overflow are omitted whole and named — never silently truncated.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './config.ts';

export type FileStatus = 'added' | 'modified' | 'renamed' | 'deleted';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  /** 1-based line number in the base version; null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the head version; null for removed lines. */
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Head path (base path for deleted files). */
  path: string;
  status: FileStatus;
  renamedFrom?: string;
  binary?: boolean;
  hunks: DiffHunk[];
}

export interface DiffArtifact {
  files: FileDiff[];
}

/** The one payload bound all diff checks inherit (ACA-0020 D4). */
export const MAX_PAYLOAD_CHARS = 120_000;

// Unified-diff convention (git's -U default); both constructors keep it so
// payloads read identically whichever source built the artifact.
const CONTEXT_LINES = 3;

// A whole-tree diff can dwarf the payload bound (oversized files are still
// parsed, then omitted at render); this caps a runaway without ever
// truncating a realistic diff.
const GIT_DIFF_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Build the artifact from git: the full merge-base-vs-working-tree diff with
 * rename detection, then filtered to the selected scope. Diffing the whole
 * tree before filtering keeps renames detectable (a pathspec naming only the
 * head side would present a rename as a bare creation); the scope filter
 * matches head paths, so deleted files — excluded from change scope anyway —
 * only appear when named explicitly by their old path.
 */
export function diffArtifactFromGit(repoRoot: string, baseRef: string, files: readonly string[]): DiffArtifact {
  let mergeBase: string;
  try {
    mergeBase = git(['merge-base', baseRef, 'HEAD'], repoRoot);
  } catch (err) {
    throw new ConfigError(`cannot resolve merge-base of ${baseRef} and HEAD: ${(err as Error).message}`);
  }
  const raw = execFileSync('git', ['diff', '-M', `--unified=${CONTEXT_LINES}`, '--no-color', mergeBase], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_DIFF_MAX_BUFFER,
  });
  const scope = new Set(files);
  const parsed = parseGitDiff(raw).filter((file) => scope.has(file.path));
  // `git diff` cannot see untracked files, but explicit CLI paths bypass
  // change-scope selection precisely so a not-yet-added file can be judged
  // during local iteration (ACA-0003 D5). Without this they would report
  // "no changes vs merge-base" — a silent miss (Codex, PR #36).
  const seen = new Set(parsed.map((file) => file.path));
  for (const file of untrackedIn(repoRoot, files)) {
    if (seen.has(file)) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    parsed.push(...diffArtifactFromTrees(new Map(), new Map([[file, content]])).files);
  }
  return { files: parsed.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

/** Which of the selected paths git considers untracked (respecting
 * .gitignore); empty when none are, and never throws on an odd path. */
function untrackedIn(repoRoot: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  try {
    const out = git(['ls-files', '--others', '--exclude-standard', '--', ...files], repoRoot);
    return out === '' ? [] : out.split('\n');
  } catch {
    return [];
  }
}

/**
 * Build the artifact from before/after file trees (pair fixtures, ACA-0020
 * D2): an in-memory LCS line diff, no git, no rename detection — a fixture
 * expressing a rename shows as delete + add.
 */
export function diffArtifactFromTrees(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): DiffArtifact {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: FileDiff[] = [];
  for (const path of paths) {
    const baseText = before.get(path);
    const headText = after.get(path);
    if (baseText === headText) continue;
    const stream = diffLines(splitLines(baseText ?? ''), splitLines(headText ?? ''));
    const status: FileStatus = baseText === undefined ? 'added' : headText === undefined ? 'deleted' : 'modified';
    files.push({ path, status, hunks: toHunks(stream) });
  }
  return { files };
}

/** Valid finding anchors: the head line numbers this change actually added. */
export function addedLineIndex(artifact: DiffArtifact): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const file of artifact.files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.kind === 'add' && line.newLine !== null) lines.add(line.newLine);
    }
    if (lines.size > 0) index.set(file.path, lines);
  }
  return index;
}

export interface OmittedFile {
  path: string;
  /** Head-side hunk ranges left unjudged, e.g. ["+10,6", "+40,2"]. */
  hunks: string[];
}

export interface RenderedPayload {
  text: string;
  included: string[];
  omitted: OmittedFile[];
}

/**
 * Render the judge payload (ACA-0020 D4). Files are rendered whole, in
 * artifact order; a file whose rendering would overflow the remaining budget
 * is omitted whole and named with its head hunk ranges (greedy
 * skip-and-continue — the omission list, not payload order, is the record of
 * what was judged).
 */
export function renderPayload(artifact: DiffArtifact, maxChars: number): RenderedPayload {
  const parts: string[] = [];
  const included: string[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;
  for (const file of artifact.files) {
    // The blank separator line is part of the rendering so the bound is
    // exact — the joined text can never exceed maxChars (Copilot, PR #36).
    const rendered = `${renderFile(file)}\n`;
    if (used + rendered.length > maxChars) {
      omitted.push({ path: file.path, hunks: file.hunks.map((hunk) => `+${hunk.newStart},${hunk.newLines}`) });
      continue;
    }
    used += rendered.length;
    parts.push(rendered);
    included.push(file.path);
  }
  return { text: parts.join('').trimEnd(), included, omitted };
}

function renderFile(file: FileDiff): string {
  const label =
    file.status === 'renamed' && file.renamedFrom
      ? `renamed from ${file.renamedFrom}`
      : file.status === 'added'
        ? 'new file'
        : file.status;
  const lines = [`=== ${file.path} (${label})`];
  if (file.binary) {
    lines.push('(binary — content not shown)');
    return `${lines.join('\n')}\n`;
  }
  for (const hunk of file.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const number = line.newLine === null ? '' : String(line.newLine);
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      lines.push(`${marker}${number.padStart(6)}| ${line.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Full LCS diff stream over two line arrays, with running line numbers. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = LCS length of before[i..] vs after[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const stream: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      stream.push({ kind: 'context', text: after[j]!, oldLine: oldLine++, newLine: newLine++ });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Ties delete first — the unified-diff convention readers expect.
      stream.push({ kind: 'del', text: before[i]!, oldLine: oldLine++, newLine: null });
      i++;
    } else {
      stream.push({ kind: 'add', text: after[j]!, oldLine: null, newLine: newLine++ });
      j++;
    }
  }
  return stream;
}

/** Group a full diff stream into hunks with the standard context margin. */
function toHunks(stream: DiffLine[], context = CONTEXT_LINES): DiffHunk[] {
  const changed = stream.map((line, index) => (line.kind === 'context' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(stream.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => {
    const lines = stream.slice(start, end + 1);
    const oldNumbers = lines.map((line) => line.oldLine).filter((line): line is number => line !== null);
    const newNumbers = lines.map((line) => line.newLine).filter((line): line is number => line !== null);
    return {
      oldStart: oldNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newStart: newNumbers[0] ?? 0,
      newLines: newNumbers.length,
      lines,
    };
  });
}

/** Parse `git diff` unified output into per-file diffs with line numbers. */
function parseGitDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldPath = '';
  let newPath = '';

  const push = (): void => {
    if (!current) return;
    // Deleted files keep their base-side identity; a binary deletion with no
    // --- header keeps the diff-header fallback.
    if (current.status === 'deleted' && oldPath !== '') current.path = oldPath;
    files.push(current);
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      push();
      // The header path is the fallback identity: binary-only diffs emit no
      // ---/+++/rename headers, and a file with an empty path would vanish
      // from scope filtering instead of rendering (Copilot, PR #36). Later
      // headers refine it when present.
      current = { path: headerPath(line), status: 'modified', hunks: [] };
      hunk = null;
      oldPath = '';
      newPath = '';
    } else if (!current) {
      continue;
    } else if (line.startsWith('new file mode')) {
      current.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.renamedFrom = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ')) {
      current.binary = true;
    } else if (line.startsWith('--- ')) {
      oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      newPath = stripPrefix(line.slice(4));
      if (newPath !== '') current.path = newPath;
    } else if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: Number(match[2] ?? '1'),
        newStart: newLine,
        newLines: Number(match[4] ?? '1'),
        lines: [],
      };
      current.hunks.push(hunk);
    } else if (hunk && line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (hunk && line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (hunk && line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
    // "\ No newline at end of file" and mode/index lines fall through.
  }
  push();
  return files;
}

function stripPrefix(path: string): string {
  if (path === '/dev/null') return '';
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/** Head-side path from a `diff --git a/<old> b/<new>` header. Splits on the
 * last ` b/` so old paths containing that byte sequence cannot shift the
 * boundary; exotic quoted paths are refined by later headers when present. */
function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  const boundary = rest.lastIndexOf(' b/');
  return boundary >= 0 ? rest.slice(boundary + 3) : '';
}
