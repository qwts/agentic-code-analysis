// Pure POSIX-path helpers shared by the adapters and the cascade resolver.
// Corpus paths are always root-relative POSIX ('a/b/c.md'); '' and '.' both
// denote a root itself.

export function posixDirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function posixBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function normalizeDir(dir: string): string {
  return dir === '.' ? '' : dir.replace(/\/+$/, '');
}

/** True when `path` (a file or dir) is `dir` or lies under it. */
export function isWithin(dir: string, path: string): boolean {
  const base = normalizeDir(dir);
  if (base === '') return true;
  return path === base || path.startsWith(`${base}/`);
}

/** Directories from the root ('') down to `dir`, inclusive. */
export function chainToDir(dir: string): readonly string[] {
  const target = normalizeDir(dir);
  if (target === '') return [''];
  const chain = [''];
  let current = '';
  for (const segment of target.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    chain.push(current);
  }
  return chain;
}

/** Depth of a directory below the root (root = 0). */
export function dirDepth(dir: string): number {
  const base = normalizeDir(dir);
  return base === '' ? 0 : base.split('/').length;
}

export function makeLocator(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}
