// Corpus and session value types plus the convention-adapter contract for
// the instruction-corpus library (docs/design/instruction-corpus.md).
// Data only: every value is readonly and erasable; no behavior lives here.

export type SessionProfileId =
  | 'codex-local'
  | 'claude-local'
  | 'claude-cloud'
  | 'copilot-cli'
  | 'copilot-cloud-agent'
  | 'copilot-code-review'
  | 'cursor-editor-agent'
  | 'cursor-cli'
  | 'cascade-legacy'
  | 'devin-local';

export const SESSION_PROFILES: readonly SessionProfileId[] = [
  'codex-local',
  'claude-local',
  'claude-cloud',
  'copilot-cli',
  'copilot-cloud-agent',
  'copilot-code-review',
  'cursor-editor-agent',
  'cursor-cli',
  'cascade-legacy',
  'devin-local',
];

export interface CorpusRootSpec {
  /** Stable id used in locators, e.g. 'repo' or 'user'. */
  readonly id: string;
  readonly kind: 'repository' | 'user';
  /** Absolute path on the host filesystem. Never exposed in locators. */
  readonly path: string;
}

export interface CorpusConfig {
  /** Codex `project_doc_fallback_filenames`. */
  readonly codexFallbackFilenames?: readonly string[];
  /** Codex `project_doc_max_bytes` (default 32 KiB). */
  readonly codexProjectDocMaxBytes?: number;
  /**
   * Claude auto-memory directory, relative to a user root
   * ('<rootId>:<path>') — the `<project>` mapping is machine-derived, so
   * it is supplied, never guessed.
   */
  readonly claudeAutoMemoryDir?: string;
}

export interface CorpusRequest {
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Explicitly authorized user roots (home-directory analogs). */
  readonly userRoots?: readonly Omit<CorpusRootSpec, 'kind'>[];
  readonly config?: CorpusConfig;
}

export interface TokenEstimate {
  readonly count: number;
  readonly estimated: true;
  /** Pinned estimator identity, e.g. 'js-tiktoken@1.0.21/o200k_base'. */
  readonly estimator: string;
}

export type SemanticsEvidence =
  | { readonly status: 'verified'; readonly source: string; readonly verifiedAt: string }
  | {
      readonly status: 'legacy' | 'unverified';
      readonly reason: string;
      readonly source?: string;
    };

export type ScopePredicate =
  | { readonly kind: 'always' }
  | { readonly kind: 'root' }
  | {
      readonly kind: 'directory-subtree';
      readonly directory: string;
      /** What brings the subtree into play: the session CWD, touched paths, or either. */
      readonly via: 'cwd' | 'touched' | 'cwd-or-touched';
    }
  | { readonly kind: 'glob'; readonly globs: readonly string[] }
  | { readonly kind: 'unresolved'; readonly reason: string };

export type ActivationPhase =
  | 'session-start'
  | 'on-path-access'
  | 'model-decision'
  | 'on-invocation'
  | 'on-demand-resource'
  | 'unresolved';

export type Cadence = 'per-session' | 'per-message' | 'once-on-trigger' | 'unresolved';

export type ProjectionKind =
  | 'whole-file'
  | 'comment-stripped'
  | 'frontmatter-fields'
  | 'body'
  | 'prefix'
  | 'imported'
  | 'none'
  | 'unresolved';

export interface ContentProjection {
  readonly kind: ProjectionKind;
  /** Selected fields for `frontmatter-fields`. */
  readonly fields?: readonly string[];
  /** Documented cap that produced a `prefix` projection. */
  readonly limit?: { readonly unit: 'bytes' | 'chars' | 'lines'; readonly value: number };
  /** The text the session is actually charged for. */
  readonly text: string;
  readonly tokens: TokenEstimate;
}

export type OrderRelation =
  | { readonly kind: 'ordered'; readonly rule: string; readonly rank: number }
  | { readonly kind: 'unordered'; readonly rule: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

export type ConflictPolicy =
  | 'closer-overrides'
  | 'later-overrides'
  | 'earlier-overrides'
  | 'combined-no-precedence'
  | 'unresolved';

export interface InstructionBinding {
  readonly tool: 'codex' | 'claude-code' | 'copilot' | 'cursor' | 'windsurf-devin';
  readonly profile: SessionProfileId;
  /** Convention id, e.g. 'codex/agents-chain' or 'claude/project-memory'. */
  readonly convention: string;
  readonly scope: ScopePredicate;
  readonly activation: ActivationPhase;
  readonly cadence: Cadence;
  readonly charged: ContentProjection;
  readonly order: OrderRelation;
  readonly conflict: ConflictPolicy;
  readonly semantics: SemanticsEvidence;
}

export type ContentKind = 'markdown' | 'mdc-rule' | 'skill' | 'instructions-md' | 'unknown';

export interface InstructionFile {
  /** `<rootId>:<posixPath>` — stable across machines. */
  readonly locator: string;
  /** Root id (`CorpusRootSpec.id`). */
  readonly origin: string;
  /** Root-relative normalized POSIX path. */
  readonly path: string;
  readonly content: string;
  readonly contentKind: ContentKind;
  readonly fullFile: TokenEstimate;
  readonly bindings: readonly InstructionBinding[];
}

export interface CorpusDiagnostic {
  readonly severity: 'info' | 'warn';
  readonly message: string;
  /** Locator or root-relative path the diagnostic is about, when file-bound. */
  readonly locator?: string;
}

export interface InstructionCorpus {
  readonly roots: readonly CorpusRootSpec[];
  readonly files: readonly InstructionFile[];
  readonly profiles: readonly SessionProfileId[];
  readonly diagnostics: readonly CorpusDiagnostic[];
  readonly estimator: string;
  /** The config snapshot discovery ran with (cascade caps come from here). */
  readonly config: CorpusConfig;
}

export interface SessionScenario {
  readonly profile: SessionProfileId;
  /** Repo-relative POSIX directory the session starts in; default '.'. */
  readonly cwd?: string;
  /** Repo-relative POSIX paths the session reads/edits. */
  readonly touchedPaths?: readonly string[];
  /** Locators of manually invoked artifacts (skills, commands, manual rules). */
  readonly invoked?: readonly string[];
  /** Locators of model-decision artifacts assumed activated. */
  readonly modelSelected?: readonly string[];
  /** Locators of approval-gated external imports the user accepted. */
  readonly acceptedExternalImports?: readonly string[];
}

export interface SessionContribution {
  readonly locator: string;
  readonly convention: string;
  readonly activation: ActivationPhase;
  readonly cadence: Cadence;
  readonly charged: TokenEstimate;
  /** Why this contribution is conditional (possible additions only). */
  readonly condition?: string;
}

export interface SessionLoadSet {
  readonly scenario: SessionScenario;
  /** Confirmed contributions in documented order (where one exists). */
  readonly contributions: readonly SessionContribution[];
  readonly confirmedTokens: TokenEstimate;
  readonly possibleAdditional: readonly SessionContribution[];
  /** False when unresolved semantics touch this profile. */
  readonly complete: boolean;
  readonly diagnostics: readonly string[];
}

// ---- adapter contract (internal to the library) ----

export interface RootListing {
  readonly root: CorpusRootSpec;
  /** Sorted root-relative POSIX file paths. */
  readonly paths: readonly string[];
}

export interface AdapterContext {
  readonly listings: readonly RootListing[];
  readonly config: CorpusConfig;
  /**
   * Memoized read of a candidate; returns null (plus an aggregator
   * diagnostic) for unreadable, oversized, or containment-violating files.
   */
  readonly read: (rootId: string, path: string) => Promise<string | null>;
  readonly estimate: (text: string) => TokenEstimate;
}

export interface AdapterBinding {
  readonly rootId: string;
  readonly path: string;
  readonly contentKind: ContentKind;
  readonly binding: InstructionBinding;
}

export interface AdapterResult {
  readonly bindings: readonly AdapterBinding[];
  readonly diagnostics: readonly CorpusDiagnostic[];
}

export interface ConventionAdapter {
  readonly id: string;
  readonly interpret: (ctx: AdapterContext) => Promise<AdapterResult>;
}
