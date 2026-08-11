// One-pass corpus discovery: validate roots, list each root once, give
// adapters memoized single-read access to candidates, then merge adapter
// bindings into physical files with deterministic ordering
// (docs/design/instruction-corpus.md, 'Discovery algorithm').

import type {
  AdapterBinding,
  ConventionAdapter,
  CorpusDiagnostic,
  CorpusRequest,
  CorpusRootSpec,
  InstructionCorpus,
  InstructionFile,
  RootListing,
  SessionProfileId,
} from './model.ts';
import { matchesGlob } from 'node:path';
import type { CorpusDeps, FileSystemPort, TokenEstimator } from './ports.ts';
import { EntryCapError } from './ports.ts';
import { matchGlob } from './cascade.ts';
import { nodeFileSystem } from './node-filesystem.ts';
import { defaultEstimator, makeEstimate } from './token-estimate.ts';
import { codexAdapter } from './conventions/codex.ts';
import { claudeAdapter } from './conventions/claude.ts';
import { copilotAdapter } from './conventions/copilot.ts';
import { cursorAdapter } from './conventions/cursor.ts';
import { windsurfAdapter } from './conventions/windsurf.ts';
import { makeLocator } from './paths.ts';

export const MAX_ENTRIES_PER_ROOT = 50_000;
export const MAX_FILE_BYTES = 1024 * 1024;

/** Always-skipped directory names; recorded as a corpus diagnostic. */
const SKIP_DIRS = ['.git', 'node_modules'];

const ADAPTERS: readonly ConventionAdapter[] = [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  cursorAdapter,
  windsurfAdapter,
].toSorted((a, b) => a.id.localeCompare(b.id));

export async function discoverInstructionCorpus(
  request: CorpusRequest,
  deps: CorpusDeps = {},
): Promise<InstructionCorpus> {
  const fileSystem: FileSystemPort = deps.fileSystem ?? nodeFileSystem;
  const estimator: TokenEstimator = deps.estimator ?? defaultEstimator;
  const diagnostics: CorpusDiagnostic[] = [];

  const roots = await validateRoots(request, fileSystem);
  // Request excludes are dropped inside the listing itself — never listed,
  // never counted toward the entry cap (a huge excluded tree must not blank
  // a root's discovery; PR #75 review) — so adapters never interpret, read,
  // or tokenize a match. The library matcher sees dotfiles under `**`
  // (instruction files live in .github, .cursor); the platform matcher
  // stays as a fallback for syntax it alone accepts (extglob).
  const excludeGlobs = request.exclude ?? [];
  let excludedCount = 0;
  const exclude =
    excludeGlobs.length === 0
      ? undefined
      : (path: string): boolean => {
          if (!excludeGlobs.some((glob) => matchGlob(glob, path) || matchesGlob(path, glob))) return false;
          excludedCount += 1;
          return true;
        };
  const listings: RootListing[] = [];
  for (const root of roots) {
    try {
      const listed = await fileSystem.listTree(root.path, {
        skipDirs: SKIP_DIRS,
        maxEntries: MAX_ENTRIES_PER_ROOT,
        exclude,
      });
      // Re-filter for injected ports that predate the exclude option; a
      // conforming port has already dropped (and counted) every match.
      const paths = exclude === undefined ? listed : listed.filter((path) => !exclude(path));
      listings.push({ root, paths });
    } catch (cause) {
      if (cause instanceof EntryCapError) {
        diagnostics.push({
          severity: 'warn',
          message: `root '${root.id}' exceeds ${MAX_ENTRIES_PER_ROOT} entries; discovery for it is incomplete`,
        });
        listings.push({ root, paths: [] });
      } else {
        throw cause;
      }
    }
  }
  diagnostics.push({
    severity: 'info',
    message: `directories skipped during listing: ${SKIP_DIRS.join(', ')}`,
  });
  if (excludeGlobs.length > 0) {
    diagnostics.push({
      severity: 'info',
      message: `request exclude globs (${excludeGlobs.join(', ')}) skipped ${excludedCount} path(s) during listing`,
    });
  }

  // Memoized single read per unique candidate, with size cap and
  // symlink containment inside the candidate's authorized root.
  const rootsById = new Map(roots.map((root) => [root.id, root]));
  const cache = new Map<string, Promise<string | null>>();
  const readDiagnostics = new Map<string, CorpusDiagnostic>();
  const read = (rootId: string, path: string): Promise<string | null> => {
    const locator = makeLocator(rootId, path);
    const cached = cache.get(locator);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<string | null> => {
      const root = rootsById.get(rootId);
      if (root === undefined) {
        readDiagnostics.set(locator, {
          severity: 'warn',
          message: `read requested for unknown root '${rootId}'`,
          locator,
        });
        return null;
      }
      const size = await fileSystem.fileSize(root.path, path);
      if (size === null) {
        readDiagnostics.set(locator, {
          severity: 'warn',
          message: 'candidate is missing or not a regular file',
          locator,
        });
        return null;
      }
      if (size > MAX_FILE_BYTES) {
        readDiagnostics.set(locator, {
          severity: 'warn',
          message: `candidate exceeds ${MAX_FILE_BYTES} bytes; content not loaded`,
          locator,
        });
        return null;
      }
      // Compare with separators normalized: Windows realpath() returns
      // backslash paths, which a literal-'/' prefix check would misread as
      // every candidate escaping its root (PR #48 review).
      const real = normalizeSeparators(await fileSystem.realPath(root.path, path));
      const rootReal = normalizeSeparators(await fileSystem.realPath(root.path, ''));
      if (real === null || rootReal === null || !(real === rootReal || real.startsWith(`${rootReal}/`))) {
        readDiagnostics.set(locator, {
          severity: 'warn',
          message: 'candidate resolves outside its authorized root; content stays unresolved',
          locator,
        });
        return null;
      }
      try {
        return await fileSystem.readFile(root.path, path);
      } catch {
        readDiagnostics.set(locator, {
          severity: 'warn',
          message: 'candidate could not be read',
          locator,
        });
        return null;
      }
    })();
    cache.set(locator, promise);
    return promise;
  };

  const bindings: AdapterBinding[] = [];
  for (const adapter of ADAPTERS) {
    const result = await adapter.interpret({
      listings,
      config: request.config ?? {},
      read,
      estimate: (text) => makeEstimate(estimator, text),
    });
    bindings.push(...result.bindings);
    diagnostics.push(...result.diagnostics);
  }

  // Merge by (origin, path): one physical file, every binding preserved.
  const byLocator = new Map<string, { file: Omit<InstructionFile, 'bindings'>; bindings: AdapterBinding[] }>();
  for (const adapterBinding of bindings) {
    const locator = makeLocator(adapterBinding.rootId, adapterBinding.path);
    const existing = byLocator.get(locator);
    if (existing !== undefined) {
      existing.bindings.push(adapterBinding);
      continue;
    }
    const content = await read(adapterBinding.rootId, adapterBinding.path);
    byLocator.set(locator, {
      file: {
        locator,
        origin: adapterBinding.rootId,
        path: adapterBinding.path,
        content: content ?? '',
        contentKind: adapterBinding.contentKind,
        fullFile: makeEstimate(estimator, content ?? ''),
      },
      bindings: [adapterBinding],
    });
  }
  // Flush after the merge loop: its read() calls (e.g. skill resources no
  // adapter read) also record diagnostics (PR #48 review).
  diagnostics.push(...readDiagnostics.values());

  const files: InstructionFile[] = [...byLocator.values()]
    .map(({ file, bindings: fileBindings }) => ({
      ...file,
      bindings: fileBindings
        .map((entry) => entry.binding)
        .toSorted((a, b) =>
          a.profile.localeCompare(b.profile) ||
          a.convention.localeCompare(b.convention) ||
          a.activation.localeCompare(b.activation),
        ),
    }))
    .toSorted((a, b) => a.locator.localeCompare(b.locator));

  const profiles = [...new Set(files.flatMap((file) => file.bindings.map((b) => b.profile)))]
    .toSorted() as SessionProfileId[];

  return {
    roots,
    files,
    profiles,
    diagnostics: diagnostics.toSorted(
      (a, b) => (a.locator ?? '').localeCompare(b.locator ?? '') || a.message.localeCompare(b.message),
    ),
    estimator: estimator.id,
    config: request.config ?? {},
  };
}

function normalizeSeparators(path: string | null): string | null {
  return path === null ? null : path.replaceAll('\\', '/');
}

async function validateRoots(
  request: CorpusRequest,
  fileSystem: FileSystemPort,
): Promise<readonly CorpusRootSpec[]> {
  const roots: CorpusRootSpec[] = [
    { id: 'repo', kind: 'repository', path: request.repoRoot },
    ...(request.userRoots ?? []).map((root) => ({ ...root, kind: 'user' as const })),
  ];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root.id === '' || root.id.includes(':')) {
      throw new Error(`invalid root id '${root.id}': must be non-empty and colon-free`);
    }
    if (seen.has(root.id)) throw new Error(`duplicate root id '${root.id}'`);
    seen.add(root.id);
    if (!root.path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root.path)) {
      throw new Error(`root '${root.id}' path must be absolute: ${root.path}`);
    }
    if (!(await fileSystem.isDirectory(root.path))) {
      throw new Error(`root '${root.id}' is not a directory: ${root.path}`);
    }
  }
  return roots;
}
