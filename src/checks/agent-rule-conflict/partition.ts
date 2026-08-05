// Pure bounded partition planning (docs/design/check-agent-rule-conflict.md):
// the whole corpus when it fits, else one unit per unique session load set
// plus cross-tool comparison units for overlapping scopes — cross-tool
// divergence must stay covered once the whole corpus stops fitting; that is
// a correctness obligation, not an optimization. Oversize indivisible units
// are marked, never silently truncated.
import type { ConflictArtifact, ProjectedSession } from './artifact.ts';

// Operational bounds pinned by the check design — deliberately far under any
// current provider window so estimator error cannot overflow.
export const TOKEN_BUDGET = 48_000;
export const BYTE_BUDGET = 320 * 1024;
export const PLAN_VERSION = 'agent-rule-conflict-plan-v1';

export interface Partition {
  readonly id: string;
  readonly kind: 'whole-corpus' | 'session-load-set' | 'cross-tool-comparison';
  readonly sessionIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly estimatedTokens: number;
  readonly bytes: number;
  /** False marks an indivisible oversize unit: skipped with a visible warn. */
  readonly fits: boolean;
}

export interface Measure {
  (sourceIds: readonly string[], sessionIds: readonly string[]): { tokens: number; bytes: number };
}

const membersOf = (session: ProjectedSession): string[] => [
  ...new Set([...session.confirmed.map((e) => e.sourceId), ...session.conditional.map((e) => e.sourceId)]),
];

/** CWD scopes overlap when one directory is ancestor-or-equal of the other. */
function scopesOverlap(a: ProjectedSession, b: ProjectedSession): boolean {
  const within = (ancestor: string, dir: string): boolean =>
    ancestor === '.' || dir === ancestor || dir.startsWith(`${ancestor}/`);
  return a.cwds.some((x) => b.cwds.some((y) => within(x, y) || within(y, x)));
}

function unit(
  kind: Partition['kind'],
  id: string,
  sessions: readonly ProjectedSession[],
  artifact: ConflictArtifact,
  measure: Measure,
): Partition {
  const wanted = new Set(sessions.flatMap(membersOf));
  const sourceIds = artifact.sources.filter((s) => wanted.has(s.id)).map((s) => s.id);
  const sessionIds = sessions.map((s) => s.id).toSorted();
  const { tokens, bytes } = measure(sourceIds, sessionIds);
  return { id, kind, sessionIds, sourceIds, estimatedTokens: tokens, bytes, fits: tokens <= TOKEN_BUDGET && bytes <= BYTE_BUDGET };
}

export function planPartitions(artifact: ConflictArtifact, measure: Measure): Partition[] {
  const whole = unit(
    'whole-corpus',
    'whole-corpus',
    artifact.sessions,
    artifact,
    measure,
  );
  if (whole.fits) return [whole];

  // Coalesce sessions with identical load sets (ordered confirmed ids plus
  // conditional ids) into one deterministic analysis unit each.
  const groups = new Map<string, ProjectedSession[]>();
  for (const session of artifact.sessions) {
    const signature = JSON.stringify([
      session.confirmed.map((e) => e.sourceId),
      session.conditional.map((e) => e.sourceId).toSorted(),
    ]);
    groups.set(signature, [...(groups.get(signature) ?? []), session]);
  }
  const units = [...groups.values()]
    .map((sessions) => {
      const ids = sessions.map((s) => s.id).toSorted();
      return unit('session-load-set', `session:${ids[0]}`, sessions, artifact, measure);
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  // Cross-tool comparison units: pairs of units from different tools whose
  // CWD scopes overlap and whose source sets differ. Each carries both
  // sides' complete load sets and session metadata — not an invented session.
  const sessionById = new Map(artifact.sessions.map((s) => [s.id, s]));
  const pairs: Partition[] = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i]!;
      const b = units[j]!;
      const sessionsA = a.sessionIds.map((id) => sessionById.get(id)!);
      const sessionsB = b.sessionIds.map((id) => sessionById.get(id)!);
      const toolsA = new Set(sessionsA.map((s) => s.tool));
      const toolsB = new Set(sessionsB.map((s) => s.tool));
      if ([...toolsA].every((tool) => toolsB.has(tool)) && [...toolsB].every((tool) => toolsA.has(tool))) continue;
      if (JSON.stringify(a.sourceIds) === JSON.stringify(b.sourceIds)) continue;
      if (!sessionsA.some((x) => sessionsB.some((y) => scopesOverlap(x, y)))) continue;
      pairs.push(unit('cross-tool-comparison', `xtool:${a.id}+${b.id}`, [...sessionsA, ...sessionsB], artifact, measure));
    }
  }
  return [...units, ...pairs];
}
