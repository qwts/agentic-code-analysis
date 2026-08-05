// Shared test doubles for the instruction-corpus suite: fixture-root
// resolution, a deterministic fake estimator (so tokenizer pin bumps cannot
// rewrite semantic goldens), an in-memory filesystem, and a recording
// wrapper that proves the one-list-per-root / one-read-per-candidate
// contract.

import { join } from 'node:path';
import type { SessionLoadSet } from '../src/corpora/instructions/index.ts';
import type { FileSystemPort, TokenEstimator } from '../src/corpora/instructions/ports.ts';
import { EntryCapError } from '../src/corpora/instructions/ports.ts';
import { nodeFileSystem } from '../src/corpora/instructions/node-filesystem.ts';

export function fixtureRoot(name: string): string {
  return join(import.meta.dirname, 'fixtures', 'instruction-corpus', name);
}

/** Counts whitespace-separated words — stable and human-checkable. */
export const fakeEstimator: TokenEstimator = {
  id: 'fake-words@1',
  estimate: (text) => (text === '' ? 0 : text.split(/\s+/).filter(Boolean).length),
};

export function locators(loadSet: SessionLoadSet): readonly string[] {
  return loadSet.contributions.map((entry) => entry.locator);
}

export function possibleLocators(loadSet: SessionLoadSet): readonly string[] {
  return loadSet.possibleAdditional.map((entry) => entry.locator);
}

/** In-memory FileSystemPort over `{rootPath: {relPath: content}}` trees. */
export function memoryFileSystem(
  trees: Record<string, Record<string, string>>,
  options: { readonly listOrder?: 'sorted' | 'reversed' } = {},
): FileSystemPort {
  return {
    async listTree(rootPath, listOptions) {
      const tree = trees[rootPath];
      if (tree === undefined) throw new Error(`unknown root ${rootPath}`);
      const paths = Object.keys(tree).toSorted();
      if (paths.length > listOptions.maxEntries) throw new EntryCapError(rootPath, listOptions.maxEntries);
      return options.listOrder === 'reversed' ? paths.toReversed() : paths;
    },
    async readFile(rootPath, relPath) {
      const content = trees[rootPath]?.[relPath];
      if (content === undefined) throw new Error(`no such file ${rootPath}/${relPath}`);
      return content;
    },
    async fileSize(rootPath, relPath) {
      const content = trees[rootPath]?.[relPath];
      return content === undefined ? null : new TextEncoder().encode(content).length;
    },
    async realPath(rootPath, relPath) {
      return relPath === '' ? rootPath : `${rootPath}/${relPath}`;
    },
    async isDirectory(absPath) {
      return trees[absPath] !== undefined;
    },
  };
}

export interface RecordingFileSystem {
  readonly port: FileSystemPort;
  readonly listCalls: string[];
  readonly readCalls: string[];
}

export function recordingFileSystem(base: FileSystemPort = nodeFileSystem): RecordingFileSystem {
  const listCalls: string[] = [];
  const readCalls: string[] = [];
  return {
    listCalls,
    readCalls,
    port: {
      listTree(rootPath, options) {
        listCalls.push(rootPath);
        return base.listTree(rootPath, options);
      },
      readFile(rootPath, relPath) {
        readCalls.push(`${rootPath}::${relPath}`);
        return base.readFile(rootPath, relPath);
      },
      fileSize: (rootPath, relPath) => base.fileSize(rootPath, relPath),
      realPath: (rootPath, relPath) => base.realPath(rootPath, relPath),
      isDirectory: (absPath) => base.isDirectory(absPath),
    },
  };
}
