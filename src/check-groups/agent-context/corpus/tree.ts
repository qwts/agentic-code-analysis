// Bounded, deterministic filesystem snapshot: one walk per authorized root,
// sorted POSIX-relative paths, memoized single reads. Safety boundary lives
// here (design doc, discovery): prune VCS/dependency/cache trees, keep
// hidden instruction directories, refuse binary or non-UTF-8 content, and
// follow symlinks only when their canonical target stays inside the walked
// root — every refusal is a diagnostic, never a silent omission. Convention
// adapters consume this snapshot and perform no filesystem access.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface TreeSnapshot {
  /** Sorted, POSIX-normalized paths relative to the root. */
  paths: string[];
  /** Memoized read; undefined means unreadable and a diagnostic was recorded. */
  content(path: string): string | undefined;
  diagnostics: string[];
}

const PRUNED = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', 'coverage']);
const MAX_BYTES = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function walkTree(rootDir: string): TreeSnapshot {
  const diagnostics: string[] = [];
  const paths: string[] = [];
  let realRoot: string;
  try {
    realRoot = realpathSync(rootDir);
  } catch {
    return { paths, diagnostics: [`root not readable: ${rootDir}`], content: () => undefined };
  }
  walk(rootDir, realRoot, '', paths, diagnostics);
  paths.sort();
  const cache = new Map<string, string | undefined>();
  return {
    paths,
    diagnostics,
    content(path: string): string | undefined {
      if (!cache.has(path)) cache.set(path, readText(join(rootDir, path), path, diagnostics));
      return cache.get(path);
    },
  };
}

function walk(dir: string, realRoot: string, prefix: string, paths: string[], diagnostics: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    diagnostics.push(`directory not readable: ${prefix || '.'}`);
    return;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!PRUNED.has(entry.name)) walk(join(dir, entry.name), realRoot, rel, paths, diagnostics);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = resolveLink(join(dir, entry.name), realRoot);
      if (target === 'escape') diagnostics.push(`symlink escapes root, skipped: ${rel}`);
      else if (target === 'dir') diagnostics.push(`symlinked directory not traversed: ${rel}`);
      else if (target === 'file') paths.push(rel);
      else diagnostics.push(`symlink unresolvable, skipped: ${rel}`);
      continue;
    }
    if (entry.isFile()) paths.push(rel);
  }
}

function resolveLink(linkPath: string, realRoot: string): 'file' | 'dir' | 'escape' | 'broken' {
  try {
    const real = realpathSync(linkPath);
    if (real !== realRoot && !real.startsWith(realRoot + '/')) return 'escape';
    return readdirIsDir(real) ? 'dir' : 'file';
  } catch {
    return 'broken';
  }
}

function readdirIsDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function readText(absPath: string, rel: string, diagnostics: string[]): string | undefined {
  let raw: Buffer;
  try {
    raw = readFileSync(absPath);
  } catch {
    diagnostics.push(`file not readable: ${rel}`);
    return undefined;
  }
  if (raw.byteLength > MAX_BYTES) {
    diagnostics.push(`file exceeds ${MAX_BYTES} bytes, skipped: ${rel}`);
    return undefined;
  }
  if (raw.includes(0)) {
    diagnostics.push(`binary content, skipped: ${rel}`);
    return undefined;
  }
  try {
    return utf8.decode(raw);
  } catch {
    diagnostics.push(`not valid UTF-8, skipped: ${rel}`);
    return undefined;
  }
}

/** In-memory snapshot for tests and injected fixture roots — same contract,
 * no filesystem. */
export function snapshotFromMap(files: ReadonlyMap<string, string>): TreeSnapshot {
  const paths = [...files.keys()].sort();
  return { paths, diagnostics: [], content: (path) => files.get(path) };
}
