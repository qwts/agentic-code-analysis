// Check-local projection of the shared corpus map into one canonical
// judgment artifact (docs/design/check-agent-rule-conflict.md): deduplicated
// sources, coalesced session load-set classes, and the canonical
// serialization that is at once judge payload, size measure, and cache-key
// body. Pure data work — no judging, no discovery, no convention semantics.
import {
  resolveInstructionSession,
  type ConflictPolicy,
  type InstructionCorpus,
  type SessionProfileId,
} from '../../corpora/instructions/index.ts';

export interface ProjectedSource {
  /** Corpus locator (`<rootId>:<posixPath>`). */
  readonly id: string;
  readonly path: string;
  readonly origin: string;
  readonly content: string;
  readonly tools: readonly string[];
  readonly estimatedTokens: number;
}

export interface ConfirmedEntry {
  readonly sourceId: string;
  readonly convention: string;
  readonly conflict: ConflictPolicy;
  readonly order: string;
}

export interface ConditionalEntry {
  readonly sourceId: string;
  readonly convention: string;
  readonly reason: string;
}

/** One deduplicated session load-set class: every (profile, CWD) pair that
 * resolves to this exact membership, with the resolver's ordered confirmed
 * contributions and visibly conditional additions. */
export interface ProjectedSession {
  /** `<profile>@<first cwd or '.'>` — deterministic (cwds are sorted). */
  readonly id: string;
  readonly profile: SessionProfileId;
  readonly tool: string;
  readonly cwds: readonly string[];
  readonly confirmed: readonly ConfirmedEntry[];
  readonly conditional: readonly ConditionalEntry[];
  readonly complete: boolean;
}

export interface ConflictArtifact {
  readonly sources: readonly ProjectedSource[];
  readonly sessions: readonly ProjectedSession[];
  readonly estimator: string;
  /** Repo-origin source paths dropped by the config exclude globs. */
  readonly excluded: readonly string[];
}

const TOOL_OF_PROFILE: Record<SessionProfileId, string> = {
  'codex-local': 'codex',
  'claude-local': 'claude-code',
  'claude-cloud': 'claude-code',
  'copilot-cli': 'copilot',
  'copilot-cloud-agent': 'copilot',
  'copilot-code-review': 'copilot',
  'cursor-editor-agent': 'cursor',
  'cursor-cli': 'cursor',
  'cascade-legacy': 'windsurf-devin',
  'devin-local': 'windsurf-devin',
};

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Dot-inclusive glob match (`**`, `*`, `?`): instruction files live in dot
 * directories (.github, .cursor), which `node:path.matchesGlob` skips under
 * `**` — an exclusion that leaks planted dotfiles would defeat the fixture
 * guard entirely. */
function matchesExclude(path: string, glob: string): boolean {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (/[.+^$()|[\]\\{}]/.test(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`).test(path);
}

/** Every semantic input the judge sees, as one canonical JSON text. The
 * instruction contents ride inside a data structure — never prompt prose. */
export function serializePayload(
  sources: readonly ProjectedSource[],
  sessions: readonly ProjectedSession[],
  estimator: string,
): string {
  return JSON.stringify(
    {
      estimator,
      sources: sources.map((s) => ({
        id: s.id,
        path: s.path,
        tools: s.tools,
        estimatedTokens: s.estimatedTokens,
        content: s.content,
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        tool: s.tool,
        profile: s.profile,
        cwds: s.cwds,
        loadOrder: s.confirmed,
        conditional: s.conditional,
        complete: s.complete,
      })),
    },
    null,
    1,
  );
}

/** Sources and sessions of one partition, in artifact order. */
export function slice(
  artifact: ConflictArtifact,
  sourceIds: readonly string[],
  sessionIds: readonly string[],
): { sources: readonly ProjectedSource[]; sessions: readonly ProjectedSession[] } {
  const wantSource = new Set(sourceIds);
  const wantSession = new Set(sessionIds);
  return {
    sources: artifact.sources.filter((s) => wantSource.has(s.id)),
    sessions: artifact.sessions.filter((s) => wantSession.has(s.id)),
  };
}

export function buildArtifact(corpus: InstructionCorpus, excludeGlobs: readonly string[]): ConflictArtifact {
  const excluded = corpus.files
    .filter((file) => file.origin === 'repo' && excludeGlobs.some((glob) => matchesExclude(file.path, glob)))
    .map((file) => file.path)
    .sort();
  const dropped = new Set(excluded);
  const kept = corpus.files.filter((file) => !(file.origin === 'repo' && dropped.has(file.path)));
  const projected: InstructionCorpus = { ...corpus, files: kept };

  const sources: ProjectedSource[] = kept
    .map((file) => ({
      id: file.locator,
      path: file.path,
      origin: file.origin,
      content: file.content,
      tools: [...new Set(file.bindings.map((b) => b.tool))].sort(),
      estimatedTokens: file.fullFile.count,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const known = new Map(kept.map((file) => [file.locator, file]));

  // One load-set class per (profile, instruction-directory CWD) — the
  // deterministic session classes of this corpus (library design; never an
  // enumeration of arbitrary trigger combinations).
  const cwds = [...new Set(kept.filter((f) => f.origin === 'repo').map((f) => dirOf(f.path)))].sort();
  const groups = new Map<string, { profile: SessionProfileId; cwds: string[]; confirmed: ConfirmedEntry[]; conditional: ConditionalEntry[]; complete: boolean }>();
  for (const profile of corpus.profiles) {
    for (const cwd of cwds) {
      const set = resolveInstructionSession(projected, { profile, cwd });
      const confirmed = set.contributions.map((entry) => {
        const binding = known
          .get(entry.locator)
          ?.bindings.find((b) => b.profile === profile && b.convention === entry.convention);
        if (binding === undefined) {
          throw new Error(`corpus projection invariant: no binding for ${entry.locator} (${profile}, ${entry.convention})`);
        }
        return {
          sourceId: entry.locator,
          convention: entry.convention,
          conflict: binding.conflict,
          order: binding.order.kind === 'ordered' ? binding.order.rule : `${binding.order.kind}: ${binding.order.kind === 'unordered' ? binding.order.rule : binding.order.reason}`,
        };
      });
      const conditional = set.possibleAdditional.map((entry) => ({
        sourceId: entry.locator,
        convention: entry.convention,
        reason: entry.condition ?? 'conditional',
      }));
      if (confirmed.length === 0 && conditional.length === 0) continue;
      const signature = JSON.stringify([profile, confirmed, conditional, set.complete]);
      const group = groups.get(signature);
      if (group !== undefined) {
        group.cwds.push(cwd);
      } else {
        groups.set(signature, { profile, cwds: [cwd], confirmed, conditional, complete: set.complete });
      }
    }
  }

  const sessions: ProjectedSession[] = [...groups.values()]
    .map((group) => ({
      id: `${group.profile}@${group.cwds[0] === '' ? '.' : group.cwds[0]}`,
      profile: group.profile,
      tool: TOOL_OF_PROFILE[group.profile],
      cwds: group.cwds.map((cwd) => (cwd === '' ? '.' : cwd)),
      confirmed: group.confirmed,
      conditional: group.conditional,
      complete: group.complete,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const session of sessions) {
    for (const entry of [...session.confirmed, ...session.conditional]) {
      if (!known.has(entry.sourceId)) {
        throw new Error(`corpus projection invariant: session ${session.id} references unknown source ${entry.sourceId}`);
      }
    }
  }

  return { sources, sessions, estimator: corpus.estimator, excluded };
}
