// Host-owned outcome layer (docs/design/check-agent-rule-conflict.md):
// atomic per-partition validation of the judge reply (exact quotes, known
// ids, envelope compatibility), criterion-independent severity from the
// corpus map (co-load decides, never the label), cross-partition
// deduplication with disagreement downgrade, and the final verdict rows.
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Verdict, Violation } from '../registry.ts';
import type { ConflictArtifact, ProjectedSession } from './artifact.ts';
import type { Partition } from './partition.ts';
import { isJudgeReply, type Assessment, type Criterion, type Resolution } from './judge-io.ts';

// Bump when the severity/aggregation policy changes; part of the cache key.
export const POLICY_VERSION = 'agent-rule-conflict-policy-v1';

export interface RuleRef {
  readonly sourceId: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly offset: number;
  readonly quote: string;
}

export interface ValidatedConflict {
  readonly criterion: Criterion;
  readonly ruleA: RuleRef;
  readonly ruleB: RuleRef;
  readonly explanation: string;
  readonly resolution: Resolution;
  readonly suggestion: string;
}

/** The cached semantic result of one partition. */
export interface PartitionOutcome {
  readonly assessment: Assessment;
  readonly note: string;
  readonly conflicts: readonly ValidatedConflict[];
}

export interface PartitionResult {
  readonly partition: Partition;
  readonly status: 'judged' | 'cached' | 'degraded' | 'skipped-oversize';
  readonly outcome?: PartitionOutcome;
  /** Degradation or skip reason. */
  readonly note?: string;
}

/** Verbatim-and-unambiguous: the quote occurs exactly once in the source. */
function locate(content: string, quote: string): number | undefined {
  if (quote.trim() === '') return undefined;
  const first = content.indexOf(quote);
  if (first === -1) return undefined;
  if (content.indexOf(quote, first + 1) !== -1) return undefined;
  return first;
}

function ruleRef(sources: ReadonlyMap<string, { path: string; content: string }>, sourceId: string, quote: string): RuleRef | string {
  const source = sources.get(sourceId);
  if (source === undefined) return `unknown source id "${sourceId}"`;
  const offset = locate(source.content, quote);
  if (offset === undefined) return `quote not found verbatim-and-unambiguously in ${source.path}`;
  const startLine = source.content.slice(0, offset).split('\n').length;
  return { sourceId, file: source.path, startLine, endLine: startLine + quote.split('\n').length - 1, offset, quote };
}

/**
 * Atomic per-partition validation: a refusal, malformed envelope, invented
 * id/quote, blank blocking evidence, or incompatible assessment degrades the
 * whole partition — never a partial authoritative result.
 */
export function validatePartition(
  result: JudgeResult,
  sources: ReadonlyMap<string, { path: string; content: string }>,
): { ok: true; outcome: PartitionOutcome } | { ok: false; note: string } {
  if (!result.ok) return { ok: false, note: result.note };
  if (!isJudgeReply(result.verdict)) return { ok: false, note: 'judge output failed schema parse' };
  const reply = result.verdict;
  if (reply.assessment === 'conflicts-found' && reply.conflicts.length === 0) {
    return { ok: false, note: 'judge found conflicts without naming one' };
  }
  if (reply.assessment !== 'conflicts-found' && reply.conflicts.length > 0) {
    return { ok: false, note: `judge said ${reply.assessment} while naming conflicts` };
  }
  const conflicts: ValidatedConflict[] = [];
  for (const conflict of reply.conflicts) {
    const a = ruleRef(sources, conflict.rule_a.source_id, conflict.rule_a.quote);
    if (typeof a === 'string') return { ok: false, note: `rule_a: ${a}` };
    const b = ruleRef(sources, conflict.rule_b.source_id, conflict.rule_b.quote);
    if (typeof b === 'string') return { ok: false, note: `rule_b: ${b}` };
    if (a.sourceId === b.sourceId && a.offset === b.offset) {
      return { ok: false, note: 'rule_a and rule_b anchor the same text span' };
    }
    if (conflict.explanation.trim() === '' || conflict.suggestion.trim() === '') {
      return { ok: false, note: 'conflict carries blank explanation or suggestion' };
    }
    // Canonical order: the pair is identity, not direction.
    const ordered = a.sourceId < b.sourceId || (a.sourceId === b.sourceId && a.offset <= b.offset);
    conflicts.push({
      criterion: conflict.criterion,
      ruleA: ordered ? a : b,
      ruleB: ordered ? b : a,
      explanation: conflict.explanation,
      resolution: conflict.resolution,
      suggestion: conflict.suggestion,
    });
  }
  return { ok: true, outcome: { assessment: reply.assessment, note: reply.reasoning_summary, conflicts } };
}

export interface AttributedFinding extends ValidatedConflict {
  readonly verdict: Verdict;
  readonly sessionsLoadingBoth: readonly string[];
  readonly sessionsPossiblyLoadingBoth: readonly string[];
  readonly semanticsUnverified: boolean;
  readonly partitionIds: readonly string[];
  readonly note?: string;
}

/** Criterion-independent severity: a verified confirmed co-load with known
 * conflict policies blocks; everything weaker warns (check design). */
function attribute(conflict: ValidatedConflict, sessions: readonly ProjectedSession[], partitionIds: readonly string[], note?: string): AttributedFinding {
  const loadingBoth: string[] = [];
  const possibly: string[] = [];
  let eligible = false;
  for (const session of sessions) {
    const entryA = session.confirmed.filter((e) => e.sourceId === conflict.ruleA.sourceId);
    const entryB = session.confirmed.filter((e) => e.sourceId === conflict.ruleB.sourceId);
    if (entryA.length > 0 && entryB.length > 0) {
      loadingBoth.push(session.id);
      const known = (entries: typeof entryA): boolean => entries.some((e) => e.conflict !== 'unresolved');
      if (known(entryA) && known(entryB)) eligible = true;
      continue;
    }
    const members = new Set([...session.confirmed.map((e) => e.sourceId), ...session.conditional.map((e) => e.sourceId)]);
    if (members.has(conflict.ruleA.sourceId) && members.has(conflict.ruleB.sourceId)) possibly.push(session.id);
  }
  const semanticsUnverified = !eligible && (loadingBoth.length > 0 || possibly.length > 0);
  const downgraded = note !== undefined;
  const reason =
    note ??
    (eligible
      ? undefined
      : loadingBoth.length > 0
        ? 'co-load conclusion depends on unresolved conflict-policy semantics'
        : possibly.length > 0
          ? 'co-load is conditional/unverified — no session confirmably loads both'
          : 'no session loads both rules');
  return {
    ...conflict,
    verdict: eligible && !downgraded ? 'fail' : 'warn',
    sessionsLoadingBoth: loadingBoth,
    sessionsPossiblyLoadingBoth: possibly,
    semanticsUnverified,
    partitionIds,
    ...(reason !== undefined ? { note: reason } : {}),
  };
}

/** Deduplicate by canonical rule pair; partitions that materially disagree
 * on a pair's criterion downgrade it to warn instead of picking one. */
export function attributeFindings(results: readonly PartitionResult[], artifact: ConflictArtifact): AttributedFinding[] {
  const byPair = new Map<string, { conflict: ValidatedConflict; criteria: Set<Criterion>; partitionIds: Set<string> }>();
  for (const result of results) {
    for (const conflict of result.outcome?.conflicts ?? []) {
      const key = JSON.stringify([conflict.ruleA.sourceId, conflict.ruleA.offset, conflict.ruleA.quote, conflict.ruleB.sourceId, conflict.ruleB.offset, conflict.ruleB.quote]);
      const entry = byPair.get(key) ?? { conflict, criteria: new Set<Criterion>(), partitionIds: new Set<string>() };
      entry.criteria.add(conflict.criterion);
      entry.partitionIds.add(result.partition.id);
      byPair.set(key, entry);
    }
  }
  const findings = [...byPair.values()].map((entry) => {
    const disagreement =
      entry.criteria.size > 1 ? `partitions disagree on the criterion (${[...entry.criteria].sort().join(' vs ')})` : undefined;
    return attribute(entry.conflict, artifact.sessions, [...entry.partitionIds].sort(), disagreement);
  });
  return findings.sort(
    (a, b) =>
      a.ruleA.file.localeCompare(b.ruleA.file) ||
      a.ruleA.startLine - b.ruleA.startLine ||
      a.criterion.localeCompare(b.criterion) ||
      a.ruleB.file.localeCompare(b.ruleB.file),
  );
}

// ---- final verdict rows ----

export interface PartitionJson {
  readonly id: string;
  readonly kind: Partition['kind'];
  readonly sessions: readonly string[];
  readonly sources: readonly string[];
  readonly estimatedTokens: number;
  readonly bytes: number;
  readonly status: PartitionResult['status'];
  readonly cached: boolean;
}

/** Check-local structural subtype (ACA-0003 stays frozen): findings carry
 * full rule references; the `(corpus)` row carries partition visibility. */
export interface ConflictVerdict extends FileVerdict {
  findings?: AttributedFinding[];
  partitions?: PartitionJson[];
  excludedSources?: string[];
  /** Corpus row only: the overall assessment lattice — `conflicts-found` if
   * any partition found one, else `uncertain` if any was, else `no-conflict`
   * when at least one partition judged cleanly. */
  assessment?: Assessment;
}

export const CORPUS_ROW = '(corpus)';

const short = (text: string): string => (text.length > 70 ? `${text.slice(0, 70)}…` : text);

function violationOf(finding: AttributedFinding): Violation {
  const at = (ref: RuleRef): string => `${ref.file}:${ref.startLine}${ref.endLine > ref.startLine ? `-${ref.endLine}` : ''}`;
  const sessions = finding.sessionsLoadingBoth.length > 0 ? finding.sessionsLoadingBoth.join(', ') : 'none';
  return {
    criterion: finding.criterion,
    evidence: `"${short(finding.ruleA.quote)}" (${at(finding.ruleA)}) vs "${short(finding.ruleB.quote)}" (${at(finding.ruleB)}); sessions: ${sessions}`,
    suggestion: `${finding.resolution}: ${finding.suggestion}`,
  };
}

function pathsOf(artifact: ConflictArtifact, sourceIds: readonly string[]): string[] {
  const byId = new Map(artifact.sources.map((s) => [s.id, s.path]));
  return sourceIds.map((id) => byId.get(id) ?? id);
}

export function toVerdicts(results: readonly PartitionResult[], artifact: ConflictArtifact): ConflictVerdict[] {
  const findings = attributeFindings(results, artifact);
  const cachedIds = new Set(results.filter((r) => r.status === 'cached').map((r) => r.partition.id));

  const byFile = new Map<string, AttributedFinding[]>();
  for (const finding of findings) {
    byFile.set(finding.ruleA.file, [...(byFile.get(finding.ruleA.file) ?? []), finding]);
  }
  const rows: ConflictVerdict[] = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, fileFindings]) => ({
      file,
      verdict: fileFindings.some((f) => f.verdict === 'fail') ? ('fail' as const) : ('warn' as const),
      cached: fileFindings.every((f) => f.partitionIds.every((id) => cachedIds.has(id))),
      violations: fileFindings.map(violationOf),
      findings: fileFindings,
    }));

  const degraded = results.filter((r) => r.status === 'degraded');
  const skipped = results.filter((r) => r.status === 'skipped-oversize');
  const uncertain = results.filter((r) => r.outcome?.assessment === 'uncertain');
  const notes: string[] = [];
  if (degraded.length > 0) notes.push(`${degraded.length} partition(s) degraded: ${degraded.map((r) => `${r.partition.id} — ${r.note}`).join('; ')}`);
  if (skipped.length > 0) {
    notes.push(
      `incomplete — oversize partition(s) skipped, sessions uncovered: ${skipped.map((r) => `${r.partition.id} (${r.partition.sessionIds.join(', ')}; ${r.note})`).join('; ')}`,
    );
  }
  if (uncertain.length > 0) notes.push(`judged uncertain: ${uncertain.map((r) => `${r.partition.id} — ${r.outcome?.note}`).join('; ')}`);
  const healthy = notes.length === 0;
  const assessments = new Set(results.map((r) => r.outcome?.assessment).filter((a): a is Assessment => a !== undefined));
  const assessment: Assessment | undefined = assessments.has('conflicts-found')
    ? 'conflicts-found'
    : assessments.has('uncertain')
      ? 'uncertain'
      : assessments.has('no-conflict')
        ? 'no-conflict'
        : undefined;
  rows.push({
    file: CORPUS_ROW,
    verdict: healthy ? 'pass' : 'warn',
    ...(assessment !== undefined ? { assessment } : {}),
    cached: results.length > 0 && results.every((r) => r.status === 'cached'),
    violations: [],
    note: healthy
      ? `${artifact.sources.length} source(s), ${artifact.sessions.length} session class(es), ${results.length} partition(s)`
      : notes.join(' | '),
    partitions: results.map((r) => ({
      id: r.partition.id,
      kind: r.partition.kind,
      sessions: r.partition.sessionIds,
      sources: pathsOf(artifact, r.partition.sourceIds),
      estimatedTokens: r.partition.estimatedTokens,
      bytes: r.partition.bytes,
      status: r.status,
      cached: r.status === 'cached',
    })),
    excludedSources: [...artifact.excluded],
  });
  return rows;
}
