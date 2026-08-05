// Document scope of the doc-drift check: the namespaced `checks.doc-drift`
// config section (parsed here — the shared core/config.ts stays frozen) and
// filesystem discovery of the doc corpus. Agent-instruction corpora are
// hard-excluded in v1 regardless of globs (check design: the agent-context
// epic owns that corpus and its cascade semantics).
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { ConfigError } from '../../core/config.ts';

export interface DocDriftScope {
  include: string[];
  exclude: string[];
}

const DEFAULTS: DocDriftScope = { include: ['README.md', 'docs/**/*.md'], exclude: [] };
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'copilot-instructions.md']);

function globList(section: Record<string, unknown>, key: string, required: boolean): string[] | undefined {
  const value = section[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string') || (required && value.length === 0)) {
    throw new ConfigError(`aca.config.json checks.doc-drift "${key}" must be a non-empty array of strings — remove the check from CI to disable it, never blank its scope`);
  }
  return value as string[];
}

/** Missing file or missing section → defaults; a present-but-malformed
 * section is a ConfigError, never a silent disable. */
export function loadDocDriftScope(repoRoot: string): DocDriftScope {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, 'aca.config.json'), 'utf8');
  } catch {
    return DEFAULTS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // core/config.ts owns reporting broken JSON; scope falls back quietly.
    return DEFAULTS;
  }
  const section = (parsed as Record<string, Record<string, unknown> | undefined> | null)?.['checks']?.['doc-drift'];
  if (section === undefined) return DEFAULTS;
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new ConfigError('aca.config.json checks.doc-drift must be an object');
  }
  const typed = section as Record<string, unknown>;
  return {
    include: globList(typed, 'include', true) ?? DEFAULTS.include,
    exclude: globList(typed, 'exclude', false) ?? DEFAULTS.exclude,
  };
}

/** Instruction files for coding agents are a different corpus with cascade
 * semantics this check does not model; excluded at any depth. */
export function isInstructionFile(relPath: string): boolean {
  const segments = relPath.split('/');
  return (
    INSTRUCTION_FILES.has(segments[segments.length - 1]!) ||
    segments.includes('.claude') ||
    segments.includes('.cursor') ||
    (segments[0] === '.github' && segments[1] === 'instructions')
  );
}

/**
 * The doc corpus: tracked paths matching the configured globs. Callers pass
 * the tracked list (git stays confined to change-index.ts) — an untracked or
 * generated Markdown file under an in-scope glob is not documentation this
 * repo ships, and must never bill a judge call (Codex review, PR #41).
 * Sorted so document order — and therefore output order — is stable.
 */
export function discoverDocs(tracked: readonly string[], scope: DocDriftScope): string[] {
  return tracked
    .filter(
      (path) =>
        scope.include.some((glob) => matchesGlob(path, glob)) &&
        !scope.exclude.some((glob) => matchesGlob(path, glob)) &&
        !isInstructionFile(path),
    )
    .sort();
}
