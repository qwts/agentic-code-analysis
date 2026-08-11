// The commit-coherence check: whole-artifact single-call judgment of "is
// this diff one logical change?". One canonical diff artifact — including
// merge-base deletions, which change scope cannot name — one cache lookup,
// at most ONE judge call per run, then a deterministic projection onto the
// frozen per-file contract. A bounded payload is never judged: coherence is
// a property of the whole change, so any omission projects warn with zero
// calls (design: docs/design/check-commit-coherence.md).
import { normalize } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import {
  diffArtifactFromGit,
  MAX_PAYLOAD_CHARS,
  renderPayload,
  type DiffArtifact,
  type OmittedFile,
  type RenderedPayload,
} from '../../core/diff-artifact.ts';
import {
  judgeOutcome,
  MAX_TOKENS,
  PROMPT_VERSION,
  systemPrompt,
  userPrompt,
  VERDICT_SCHEMA,
  type ArtifactOutcome,
  type CoherenceFinding,
  type SplitPart,
} from './judge-io.ts';
import { selfTest } from './self-test.ts';

/** Run-level evidence for --json: call count, cache decision, coverage, and
 * the structured judgment (intent, findings, split). Every verdict entry
 * carries the same object — duck-typed, so the shared contract is not
 * widened. */
export interface RunMeta {
  judgeCalls: number;
  cacheHit: boolean;
  judged: string[];
  omitted: OmittedFile[];
  assessment?: string;
  overallIntent?: string;
  findings?: CoherenceFinding[];
  splitProposal?: SplitPart[];
}

export interface CommitCoherenceVerdict extends FileVerdict {
  run?: RunMeta;
}

/** What a cache entry stores: the judged artifact-level outcome only — the
 * projection is derived fresh each run from the (identical) artifact. */
type StoredOutcome = Pick<ArtifactOutcome, 'assessment' | 'verdict' | 'overallIntent' | 'findings' | 'splitProposal' | 'note'>;

function cacheKey(artifact: DiffArtifact, payload: RenderedPayload, provider: string, model: string): string {
  return VerdictCache.key([PROMPT_VERSION, String(MAX_TOKENS), JSON.stringify(artifact), payload.text, JSON.stringify(payload.omitted), provider, model]);
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const scoped = [...new Set(context.files.map((file) => normalize(file)))].sort();
  // No early return on an empty scope: change scope excludes deletions by
  // design, so a deletion-only change arrives as zero files and the
  // deletions must still be judged (Codex, PR #47).
  const artifact = diffArtifactFromGit(context.repoRoot, context.baseRef, scoped, { includeDeletions: true });
  const payload = renderPayload(artifact, MAX_PAYLOAD_CHARS);
  // Rows: the scoped files plus deletion-only paths the artifact carries.
  const rows = [...new Set([...scoped, ...artifact.files.map((file) => file.path)])].sort();
  if (rows.length === 0) return [];
  const meta: RunMeta = { judgeCalls: 0, cacheHit: false, judged: payload.included, omitted: payload.omitted };

  let outcome: ArtifactOutcome;
  if (artifact.files.length === 0) {
    outcome = { verdict: 'pass', findings: [], splitProposal: [], cacheable: false };
  } else if (payload.omitted.length > 0) {
    // Partial evidence cannot support "one logical change" in either
    // direction: no call, no cache, every row warns.
    outcome = {
      verdict: 'warn',
      findings: [],
      splitProposal: [],
      note: `not judged — diff exceeds the ${MAX_PAYLOAD_CHARS}-char payload bound (omitted: ${payload.omitted.map((entry) => entry.path).join(', ')})`,
      cacheable: false,
    };
  } else {
    const key = cacheKey(artifact, payload, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as StoredOutcome | undefined;
    if (hit) {
      meta.cacheHit = true;
      outcome = { ...hit, cacheable: true };
    } else {
      meta.judgeCalls = 1;
      const result = await context.client.judge({
        system: systemPrompt(),
        user: userPrompt(payload.text, artifact),
        schema: VERDICT_SCHEMA,
        maxTokens: MAX_TOKENS,
      });
      outcome = judgeOutcome(result, artifact);
      if (outcome.cacheable) {
        const { cacheable: _, ...stored } = outcome;
        context.cache.set(key, stored satisfies StoredOutcome);
      }
    }
    meta.assessment = outcome.assessment;
    meta.overallIntent = outcome.overallIntent;
    meta.findings = outcome.findings;
    meta.splitProposal = outcome.splitProposal;
  }
  return project(rows, artifact, outcome, meta);
}

const renderSplit = (parts: SplitPart[]): string =>
  `split into: ${parts.map((part) => `"${part.name}" — ${part.units.join(', ')}`).join('; ')}`;

function project(rows: string[], artifact: DiffArtifact, outcome: ArtifactOutcome, meta: RunMeta): CommitCoherenceVerdict[] {
  const byPath = new Map(artifact.files.map((file) => [file.path, file]));
  return rows.map((file) => {
    const diff = byPath.get(file);
    const base = { file, cached: meta.cacheHit, violations: [], run: meta } satisfies Omit<CommitCoherenceVerdict, 'verdict'>;
    if (!diff) return { ...base, cached: false, verdict: 'pass' as const, note: 'no changes vs merge-base' };
    const deleted = diff.status === 'deleted' ? { note: 'deleted vs merge-base' } : {};
    if (outcome.verdict === 'warn') return { ...base, verdict: 'warn' as const, ...(outcome.note !== undefined ? { note: outcome.note } : {}) };
    const findings = outcome.findings.filter((finding) => finding.files.includes(file));
    if (outcome.verdict === 'fail' && findings.length > 0) {
      return {
        ...base,
        verdict: 'fail' as const,
        violations: findings.map((finding) => ({
          criterion: finding.criterion,
          evidence: `${finding.files.join(', ')} — ${finding.evidence}`,
          suggestion: renderSplit(outcome.splitProposal),
        })),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      };
    }
    return { ...base, verdict: 'pass' as const, ...deleted };
  });
}

export const check: Check = {
  name: 'commit-coherence',
  tier: 'T1',
  run,
  selfTest,
};
