// Injected dependencies for corpus discovery: the filesystem port and the
// token estimator. Production defaults live in node-filesystem.ts and
// token-estimate.ts; tests inject fakes.

export interface ListTreeOptions {
  /** Directory names always skipped (recorded by the caller, not here). */
  readonly skipDirs: readonly string[];
  /** Hard cap on listed entries; the port throws EntryCapError beyond it. */
  readonly maxEntries: number;
}

export class EntryCapError extends Error {
  constructor(rootPath: string, cap: number) {
    super(`listing of ${rootPath} exceeded ${cap} entries`);
    this.name = 'EntryCapError';
  }
}

export interface FileSystemPort {
  /** Sorted root-relative POSIX file paths under an absolute root. */
  readonly listTree: (rootPath: string, options: ListTreeOptions) => Promise<readonly string[]>;
  /** UTF-8 content of one file; byte size checked by the caller via stat. */
  readonly readFile: (rootPath: string, relPath: string) => Promise<string>;
  /** File size in bytes, or null when the entry is missing/unstatable. */
  readonly fileSize: (rootPath: string, relPath: string) => Promise<number | null>;
  /**
   * Canonical absolute path (symlinks resolved), or null when resolution
   * fails. Used for authorized-root containment checks.
   */
  readonly realPath: (rootPath: string, relPath: string) => Promise<string | null>;
  /** True when the absolute path exists and is a directory. */
  readonly isDirectory: (absPath: string) => Promise<boolean>;
}

export interface TokenEstimator {
  /** Pinned identity, e.g. 'js-tiktoken@1.0.21/o200k_base'. */
  readonly id: string;
  readonly estimate: (text: string) => number;
}

export interface CorpusDeps {
  readonly fileSystem?: FileSystemPort;
  readonly estimator?: TokenEstimator;
}
