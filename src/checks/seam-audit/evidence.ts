// Evidence extraction for one snapshot: what does this file reach for?
// Outbound dependencies (static imports, re-exports, side-effect imports,
// dynamic imports, and lexically resolvable CommonJS require) plus
// conservative ambient-access candidates. Both are orientation for the judge
// — the source stays authoritative — and candidates are hints, never an
// exhaustive verdict. Git and snapshot assembly live in comparison.ts.
// POSIX helpers on purpose: these paths are repo-relative git paths, which
// use '/' on every platform — platform-specific normalization would produce
// '\\' separators on Windows and break graph/cache identity (Copilot, PR #34).
import { dirname, join, normalize } from 'node:path/posix';

const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function dependencySpecifiers(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) found.push(spec);
  }
  return found;
}

/** Relative specifiers resolve to repo-relative paths; bare ones stay as-is. */
export function resolveSpecifier(fromFile: string, spec: string): string {
  return spec.startsWith('.') ? normalize(join(dirname(fromFile), spec)) : spec;
}

export function dependenciesOf(file: string, content: string): string[] {
  return [...new Set(dependencySpecifiers(content).map((spec) => resolveSpecifier(file, spec)))].sort();
}

/** Fixed, deliberately small pattern list: each label appears at most once,
 * in this order, when its pattern occurs anywhere in the content. */
const AMBIENT: readonly [RegExp, string][] = [
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(/, 'Date (clock)'],
  [/\bperformance\.now\s*\(/, 'performance.now (clock)'],
  [/\bMath\.random\s*\(/, 'Math.random'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bprocess\s*\.\s*\w+/, 'process.*'],
  [/\bglobalThis\s*\.\s*\w+/, 'globalThis.*'],
  [/\b(?:window|document|navigator|localStorage|sessionStorage)\b/, 'DOM/browser global'],
  [/\bset(?:Timeout|Interval)\s*\(/, 'timers'],
  [/\brequire\s*\(/, 'require'],
  [/\bnew\s+[A-Z]\w*\s*\(/, 'constructor call (new X(...))'],
];

export function ambientCandidates(content: string): string[] {
  return AMBIENT.filter(([pattern]) => pattern.test(content)).map(([, label]) => label);
}
