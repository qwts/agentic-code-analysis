// The mechanical prefilter's grammar (check design, "Reference extraction"):
// a pure Markdown scanner that recognizes only explicit reference syntax —
// link paths, code-literal paths, code-formatted symbols, --flags, and
// command words. It never reads the filesystem and never fetches a URL; the
// documented misses (prose-only references, aliases, unsupported constructs)
// are part of the contract, not bugs.
import { posix } from 'node:path';

export const SCAN_MODE = 'explicit-markdown-references';

export type ReferenceKind = 'path' | 'symbol' | 'flag' | 'command';

export interface RawReference {
  kind: ReferenceKind;
  /** The token as written in the document. */
  literal: string;
  /** 1-indexed document line of the first occurrence. */
  line: number;
  /** Repo-relative normalized target — `path` kind only. */
  resolvedPath?: string;
}

const LINK = /!?\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE = /``([^`]+)``|`([^`]+)`/g;
const FLAG = /(?<![\w-])--[A-Za-z][A-Za-z0-9-]*/g;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
const COMMAND_WORD = /^[a-z][a-z0-9._-]*$/;
// A path literal: contains a separator, or is a bare well-known file name.
// The scanning form finds paths embedded in quotes/punctuation inside code.
const PATHISH = /^[\w.@-]+(?:\/[\w.@-]+)+$/;
const PATH_IN_TEXT = /[\w.@-]+(?:\/[\w.@-]+)+/g;
const BARE_FILE = /^[\w-]+(?:\.[\w-]+)*\.(?:md|ts|mts|cts|js|mjs|cjs|tsx|jsx|json|jsonc|ya?ml|toml|txt|sh|css|html|py|rs|go)$/;
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console', 'zsh']);

/** Resolve a document-relative link or a repo-relative code literal to a
 * repo-relative path; undefined rejects schemes, absolute paths, bare
 * anchors, and traversal outside the repo. */
function resolveTarget(raw: string, docDir: string, relativeToDoc: boolean): string | undefined {
  if (raw === '' || raw.startsWith('#') || raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
  const noAnchor = raw.split('#')[0]!;
  if (noAnchor === '') return undefined;
  const joined = relativeToDoc ? posix.join(docDir, noAnchor) : noAnchor;
  const normalized = posix.normalize(joined);
  if (normalized.startsWith('..') || normalized === '.') return undefined;
  return normalized;
}

export function extractReferences(docPath: string, content: string): RawReference[] {
  const docDir = posix.dirname(docPath);
  const seen = new Map<string, RawReference>();
  const add = (reference: RawReference): void => {
    const key = `${reference.kind}\0${reference.literal}\0${reference.resolvedPath ?? ''}`;
    if (!seen.has(key)) seen.set(key, reference);
  };
  const addPath = (literal: string, line: number, relativeToDoc: boolean): void => {
    const resolvedPath = resolveTarget(literal, docDir, relativeToDoc);
    if (resolvedPath !== undefined) add({ kind: 'path', literal, line, resolvedPath });
  };
  // Commands carry their subcommand: `aca doc-drift --json` names two words
  // a rename could break, not one.
  const addCommandWords = (text: string, line: number): void => {
    const words = text.trim().split(/\s+/);
    for (const word of words.slice(0, 2)) {
      if (COMMAND_WORD.test(word) && !word.startsWith('--')) add({ kind: 'command', literal: word, line });
      else break;
    }
  };
  const addCodeToken = (token: string, line: number, inShellFence: boolean): void => {
    for (const flag of token.match(FLAG) ?? []) add({ kind: 'flag', literal: flag, line });
    const words = token.trim().split(/\s+/);
    if (words.length === 1) {
      const word = words[0]!;
      // Code-literal paths are repo-relative by convention (check design).
      if (PATHISH.test(word) || BARE_FILE.test(word)) addPath(word, line, false);
      else if (!inShellFence && SYMBOL.test(word)) add({ kind: 'symbol', literal: word, line });
      else if (inShellFence) addCommandWords(word, line);
      return;
    }
    for (const match of token.match(PATH_IN_TEXT) ?? []) addPath(match, line, false);
    addCommandWords(token, line);
  };

  const lines = content.split('\n');
  let fenceLang: string | undefined;
  lines.forEach((text, index) => {
    const line = index + 1;
    const fence = text.match(/^\s*(?:```|~~~)\s*([A-Za-z0-9-]*)/);
    if (fence) {
      fenceLang = fenceLang === undefined ? (fence[1] || '(none)') : undefined;
      return;
    }
    if (fenceLang !== undefined) {
      // Inside a fence: paths and flags from any language; commands only
      // from shell examples (an identifier in a TS fence is not a claim the
      // scanner can bound, so symbols stay inline-code-only).
      const shell = SHELL_LANGS.has(fenceLang);
      const body = shell ? text.replace(/^\s*[$>]\s+/, '') : text;
      if (shell && /^\s*#/.test(body)) return;
      for (const flag of body.match(FLAG) ?? []) add({ kind: 'flag', literal: flag, line });
      for (const match of body.match(PATH_IN_TEXT) ?? []) addPath(match, line, false);
      if (shell && body.trim() !== '') addCommandWords(body, line);
      return;
    }
    for (const match of text.matchAll(LINK)) addPath(match[1]!, line, true);
    for (const match of text.matchAll(INLINE_CODE)) addCodeToken(match[1] ?? match[2]!, line, false);
  });
  return [...seen.values()];
}

/** Exact word-boundary occurrence of a token in referent text — the match
 * semantics the design fixes per kind; substring matches never count. */
export function tokenMatches(text: string, kind: Exclude<ReferenceKind, 'path'>, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = kind === 'flag' ? `(?<![\\w-])${escaped}(?![\\w-])` : `(?<![\\w$])${escaped}(?![\\w$])`;
  return new RegExp(pattern).test(text);
}
