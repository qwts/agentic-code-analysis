// The review-readiness check: whole-artifact single-call judgment (contrast
// with context-footprint's per-file fan-out). One canonical diff artifact,
// one cache lookup, at most ONE judge call per run — outside any file loop —
// then a deterministic projection onto the frozen per-file contract for the
// renderer. Artifact-granular caching: the key is the full canonical diff
// (including content omitted from a bounded payload), so an unchanged
// worktree costs zero API calls while a change confined to omitted content
// still invalidates.
import { normalize } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import {
  addedLineIndex,
  diffArtifactFromGit,
  MAX_PAYLOAD_CHARS,
  renderPayload,
  type DiffArtifact,
  type OmittedFile,
  type RenderedPayload,
} from '../../core/diff-artifact.ts';
import { judgeOutcome, MAX_TOKENS, PROMPT_VERSION, systemPrompt, userPrompt, VERDICT_SCHEMA, type ArtifactOutcome, type ReviewFinding } from './judge-io.ts';
import { selfTest } from './self-test.ts';

/** Run-level evidence for --json: call count, cache decision, coverage.
 * Every verdict entry carries the same object — duck-typed, so the shared
 * contract is not widened. */
export interface RunMeta {
  judgeCalls: number;
  cacheHit: boolean;
  judged: string[];
  omitted: OmittedFile[];
}

/** Check-local verdict subtype: structured findings keep the numeric line
 * in --json; rendered evidence is prefixed path:line for text output. */
export interface ReviewReadinessVerdict extends FileVerdict {
  findings?: ReviewFinding[];
  run?: RunMeta;
}

/** What a cache entry stores: the judged artifact-level outcome only — the
 * projection is derived fresh each run from the (identical) artifact. */
type StoredOutcome = Pick<ArtifactOutcome, 'assessment' | 'verdict' | 'findings' | 'note'>;

function cacheKey(artifact: DiffArtifact, payload: RenderedPayload, provider: string, model: string): string {
  // The rendered payload and omission manifest are derivable from the
  // artifact, but keying on them too means a renderer or bound change
  // cannot serve a stale judgment even if the prompt version were missed.
  return VerdictCache.key([PROMPT_VERSION, JSON.stringify(artifact), payload.text, JSON.stringify(payload.omitted), provider, model]);
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const files = [...new Set(context.files.map((file) => normalize(file)))].sort();
  if (files.length === 0) return [];
  const artifact = diffArtifactFromGit(context.repoRoot, context.baseRef, files);
  const payload = renderPayload(artifact, MAX_PAYLOAD_CHARS);
  const meta: RunMeta = { judgeCalls: 0, cacheHit: false, judged: payload.included, omitted: payload.omitted };

  let outcome: ArtifactOutcome;
  if (artifact.files.length === 0 || payload.included.length === 0) {
    // Nothing judgeable: an empty diff, or a diff so large every file fell
    // out of the bound. Zero calls either way; omitted files project warn.
    outcome = { verdict: 'pass', findings: [], cacheable: false };
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
        user: userPrompt(payload),
        schema: VERDICT_SCHEMA,
        maxTokens: MAX_TOKENS,
      });
      outcome = judgeOutcome(result, addedLineIndex(artifact));
      if (outcome.cacheable) {
        const stored: StoredOutcome = {
          verdict: outcome.verdict,
          findings: outcome.findings,
          ...(outcome.assessment !== undefined ? { assessment: outcome.assessment } : {}),
          ...(outcome.note !== undefined ? { note: outcome.note } : {}),
        };
        context.cache.set(key, stored);
      }
    }
  }
  return project(files, artifact, outcome, meta);
}

function project(files: string[], artifact: DiffArtifact, outcome: ArtifactOutcome, meta: RunMeta): ReviewReadinessVerdict[] {
  const byPath = new Map(artifact.files.map((file) => [file.path, file]));
  const omitted = new Map(meta.omitted.map((entry) => [entry.path, entry]));
  return files.map((file) => {
    const base = { file, cached: false, violations: [], run: meta } satisfies Omit<ReviewReadinessVerdict, 'verdict'>;
    const diff = byPath.get(file);
    if (!diff) return { ...base, verdict: 'pass' as const, note: 'no changes vs merge-base' };
    const omission = omitted.get(file);
    if (omission) {
      return {
        ...base,
        verdict: 'warn' as const,
        note: `not judged — diff exceeds the ${MAX_PAYLOAD_CHARS}-char payload bound (omitted head hunks: ${omission.hunks.join(', ') || '(binary)'})`,
      };
    }
    const judged = { ...base, cached: meta.cacheHit };
    if (outcome.verdict === 'warn') return { ...judged, verdict: 'warn' as const, ...(outcome.note !== undefined ? { note: outcome.note } : {}) };
    const findings = outcome.findings.filter((finding) => finding.file === file);
    if (outcome.verdict === 'fail' && findings.length > 0) {
      return {
        ...judged,
        verdict: 'fail' as const,
        findings,
        violations: findings.map((finding) => ({
          criterion: finding.criterion,
          evidence: `${finding.file}:${finding.line} — ${finding.evidence}`,
          suggestion: finding.suggestion,
        })),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      };
    }
    return { ...judged, verdict: 'pass' as const };
  });
}

export const check: Check = {
  name: 'review-readiness',
  tier: 'T1',
  run,
  selfTest,
};
