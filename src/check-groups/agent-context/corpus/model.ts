// Domain model of the instruction corpus (ACA-0023): what instruction
// sources exist, which tool loads each one when, and what each session pays.
// Data only — no judgment, no I/O. Paths are POSIX-normalized and relative
// to their root; ids are machine-independent.

export type Origin = 'repository' | 'user';
export type Tool = 'codex' | 'claude-code' | 'copilot' | 'cursor' | 'windsurf';

/** When a fragment's tokens are actually paid. `manual` never enters
 * automatic totals; `unknown` can never enter a confirmed total. */
export type Activation = 'always' | 'path' | 'model-selected' | 'manual' | 'unknown';

export interface TokenEstimate {
  /** Reference estimate, never a billing claim. */
  tokens: number;
  /** Exact UTF-8 byte count. */
  bytes: number;
  estimated: true;
  estimator: string;
}

export type SemanticsEvidence =
  | { status: 'verified'; source: string; verifiedAt: string }
  | { status: 'unverified'; reason: string };

/** Text actually delivered at one stage — a skill's routing metadata is paid
 * continuously while its body is conditional, so they are distinct fragments. */
export interface Fragment {
  kind: 'body' | 'metadata' | 'import';
  activation: Activation;
  text: string;
  estimate: TokenEstimate;
}

export interface ToolBinding {
  tool: Tool;
  convention: string;
  /** Directory this binding applies beneath ('' = repository root). */
  scopeDir: string;
  /** Present only for glob-conditioned (`path`-activated) rules. */
  pathGlobs?: string[];
  activation: Activation;
  fragments: Fragment[];
  semantics: SemanticsEvidence;
}

export interface InstructionSource {
  /** `repo:<path>` or `user:<label>/<path>` — never a machine path. */
  id: string;
  origin: Origin;
  path: string;
  content: string;
  sha256: string;
  /** Whole-file estimate; per-stage charges live on fragments. */
  estimate: TokenEstimate;
  bindings: ToolBinding[];
  diagnostics: string[];
}

export interface LoadEntry {
  sourceId: string;
  activation: Activation;
  /** Sum over this binding's delivered fragments at this activation. */
  tokens: number;
  verified: boolean;
}

/** One deterministic session cost class: tool × the directory where its
 * instruction scope last changed. Ordered root→leaf per the tool's docs. */
export interface SessionLoadSet {
  id: string;
  tool: Tool;
  /** Deepest scope directory of the class ('' = root). */
  targetDir: string;
  entries: LoadEntry[];
  /** Verified always-on fragments only. */
  baselineTokens: number;
  /** Path/model-selected/unknown fragments — potential, never claimed paid. */
  conditionalTokens: number;
  /** Explicit invocations, excluded from automatic totals. */
  manualTokens: number;
  /** False whenever an unverified binding participates. */
  complete: boolean;
}

export interface InstructionCorpus {
  sources: InstructionSource[];
  loadSets: SessionLoadSet[];
  diagnostics: string[];
  estimator: string;
}

export const TOOLS: readonly Tool[] = ['codex', 'claude-code', 'copilot', 'cursor', 'windsurf'];

export function sourceId(origin: Origin, rootLabel: string, path: string): string {
  return origin === 'repository' ? `repo:${path}` : `user:${rootLabel}/${path}`;
}

/** Locale-independent ordering — localeCompare would make corpus output
 * depend on the host locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
