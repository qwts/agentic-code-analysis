// Production FileSystemPort: bounded recursive listing with deterministic
// order, no traversal into symlinked directories, and realpath support for
// authorized-root containment checks.

import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { EntryCapError, type FileSystemPort, type ListTreeOptions } from './ports.ts';

function toPosix(relPath: string): string {
  return sep === '/' ? relPath : relPath.split(sep).join('/');
}

async function listInto(
  rootPath: string,
  relDir: string,
  options: ListTreeOptions,
  out: string[],
): Promise<void> {
  const dir = await opendir(join(rootPath, relDir));
  const files: string[] = [];
  const dirs: string[] = [];
  // Dirent.isDirectory() is false for symlinks, so a symlinked directory is
  // never traversed (it lists as a file entry; reads on it fail cleanly).
  // Symlinked files stay listed — CLAUDE.md → AGENTS.md links are documented.
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      if (!options.skipDirs.includes(entry.name)) dirs.push(entry.name);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entry.name);
    }
  }
  files.sort();
  dirs.sort();
  for (const name of files) {
    if (out.length >= options.maxEntries) throw new EntryCapError(rootPath, options.maxEntries);
    out.push(relDir === '' ? name : `${relDir}/${name}`);
  }
  for (const name of dirs) {
    await listInto(rootPath, relDir === '' ? name : `${relDir}/${name}`, options, out);
  }
}

export const nodeFileSystem: FileSystemPort = {
  async listTree(rootPath, options) {
    const out: string[] = [];
    await listInto(rootPath, '', options, out);
    return out.map(toPosix);
  },
  async readFile(rootPath, relPath) {
    return readFile(join(rootPath, ...relPath.split('/')), 'utf8');
  },
  async fileSize(rootPath, relPath) {
    const info = await stat(join(rootPath, ...relPath.split('/'))).catch(() => null);
    return info?.isFile() ? info.size : null;
  },
  async realPath(rootPath, relPath) {
    return realpath(join(rootPath, ...relPath.split('/'))).catch(() => null);
  },
  async isDirectory(absPath) {
    const info = await stat(resolve(absPath)).catch(() => null);
    return info?.isDirectory() ?? false;
  },
};
