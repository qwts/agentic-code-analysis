// The check-local second scope stage (check design: Scope): which of the
// already-selected changed files are tests. Defaults are pattern-based so
// helpers and fixtures colocated under test directories are not judged as
// tests; a consuming repo's checks.test-honesty.testFiles stanza replaces
// them. Out-of-corpus files are dropped, never judged — this check never
// treats a production file as a test.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, matchesGlob, normalize } from 'node:path';
import { ConfigError } from '../../core/config.ts';

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*', // JS/TS
  '**/*.spec.*', // JS/TS
  '**/__tests__/**', // JS/TS (jest layout)
  '**/test_*.py', // Python
  '**/*_test.py', // Python
  '**/*_test.go', // Go
  'tests/**/*.rs', // Rust integration tests
  '**/src/test/**', // JVM (Maven/Gradle layout)
  '**/*Test.cs', // .NET
  '**/*Tests.cs', // .NET
  '**/*_spec.rb', // Ruby
  '**/*_test.rb', // Ruby
  '**/*Test.php', // PHP
];

/**
 * Reads the optional checks.test-honesty.testFiles stanza from the consuming
 * repo's aca.config.json. The core loader ignores unknown keys, so this
 * parsing stays check-local (issue #15) — the frozen AcaConfig/CheckContext
 * contracts do not widen. A configured list replaces the defaults; an empty
 * or malformed list is a ConfigError, never a silent way to disable the gate.
 */
export function testFileGlobs(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, 'aca.config.json'), 'utf8');
  } catch {
    return [...DEFAULT_TEST_GLOBS];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`aca.config.json is not valid JSON: ${(err as Error).message}`);
  }
  const stanza = (((parsed as Record<string, unknown>)?.['checks'] as Record<string, unknown>)?.['test-honesty'] as Record<string, unknown>)?.['testFiles'];
  if (stanza === undefined) return [...DEFAULT_TEST_GLOBS];
  if (!Array.isArray(stanza) || stanza.length === 0 || stanza.some((glob) => typeof glob !== 'string' || glob === '')) {
    throw new ConfigError('aca.config.json checks.test-honesty.testFiles must be a non-empty array of glob strings');
  }
  return stanza as string[];
}

export function isTestFile(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(file, glob));
}

/** Normalize, deduplicate, and keep repo-relative test files only, preserving
 * input order. Absolute and repo-escaping explicit paths are dropped: every
 * later read is join(repoRoot, file) and must stay inside the repository
 * (Copilot, PR #32). */
export function scopeTestFiles(files: string[], globs: readonly string[]): string[] {
  return [...new Set(files.map((file) => normalize(file)))].filter(
    (file) => !isAbsolute(file) && !file.startsWith('..') && isTestFile(file, globs),
  );
}
