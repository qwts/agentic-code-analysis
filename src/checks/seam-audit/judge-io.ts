// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The rubric is a runtime-read asset embedded verbatim — never
// paraphrased here — so the rubric and the judge cannot drift apart. The
// judgment is comparative (ACA-0013): direction of change for legacy files,
// absolute state only for new ones; gate policy stays in host code.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Violation } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';

// Bump on ANY prompt change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'seam-audit-v1';

// Operational bound (check design): one file per request, 4096 output tokens.
export const MAX_TOKENS = 4096;

const RUBRIC_PATH = fileURLToPath(new URL('./rubric.md', import.meta.url));

export function rubricText(): string {
  return readFileSync(RUBRIC_PATH, 'utf8');
}

export const CRITERIA = ['hardwired-dependency', 'ambient-state', 'ambient-io', 'import-time-side-effect'] as const;
export type Criterion = (typeof CRITERIA)[number];

export const ASSESSMENTS = ['new-compliant', 'new-violating', 'improved', 'held', 'regressed', 'uncertain'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

/** Per-item direction of a missing seam. No per-item "uncertain": ambiguity
 * is an assessment-level judgment (design deviation note). */
export const CHANGES = ['new', 'introduced', 'worsened', 'pre-existing'] as const;
export type Change = (typeof CHANGES)[number];

const BLOCKING_CHANGES: readonly Change[] = ['new', 'introduced', 'worsened'];

/** What each comparison kind may legitimately be assessed as; anything else
 * is a malformed reply, not a verdict. */
const KIND_ASSESSMENTS: Record<Comparison['kind'], readonly Assessment[]> = {
  new: ['new-compliant', 'new-violating', 'uncertain'],
  legacy: ['improved', 'held', 'regressed', 'uncertain'],
};

/** What each comparison kind may mark an item as. */
const KIND_CHANGES: Record<Comparison['kind'], readonly Change[]> = {
  new: ['new'],
  legacy: ['introduced', 'worsened', 'pre-existing'],
};

/** One enumerated entry of the testability footprint. */
export interface SeamDependency {
  dependency: string;
  criterion: Criterion;
  change: Change;
  access_point: string;
  evidence: string;
  test_patch: string;
  suggested_seam: string;
}

/**
 * The check's verdict subtype: `violations` stays the blocking evidence;
 * `residualViolations` is nonblocking debt retained on improved/held legacy
 * files; `testabilityFootprint` preserves the full structured enumeration;
 * `source` makes the zero-call mechanical path observable in --json. Extends
 * the registry contract structurally — the shared FileVerdict is not widened.
 */
export interface SeamAuditVerdict extends FileVerdict {
  assessment?: Assessment;
  /** Base identity when it differs from `file` (rename). */
  basePath?: string;
  source?: 'judge' | 'mechanical-prefilter';
  testabilityFootprint?: SeamDependency[];
  residualViolations?: Violation[];
}

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'comparison_evidence', 'dependencies_without_seams', 'reasoning_summary'],
  properties: {
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    comparison_evidence: { type: 'string' },
    dependencies_without_seams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dependency', 'criterion', 'change', 'access_point', 'evidence', 'test_patch', 'suggested_seam'],
        properties: {
          dependency: { type: 'string' },
          criterion: { type: 'string', enum: [...CRITERIA] },
          change: { type: 'string', enum: [...CHANGES] },
          access_point: { type: 'string' },
          evidence: { type: 'string' },
          test_patch: { type: 'string' },
          suggested_seam: { type: 'string' },
        },
      },
    },
    reasoning_summary: { type: 'string' },
  },
};

export function systemPrompt(rubricText: string): string {
  return `You judge how one source file changed, against a testable-seams rubric. The rubric, verbatim and authoritative:

<rubric>
${rubricText}
</rubric>

Each request carries one file as either kind "new" (head version only — judge it absolutely against the rubric) or kind "legacy" (base and head versions — judge the DIRECTION of the change, not the head's absolute state). Answer the rubric's practical test for each provided version: to write a focused test of this file's core logic, what would the test have to patch?

Enumerate the testability footprint in dependencies_without_seams: one item per dependency of the HEAD version that has no seam, labeled with exactly one criterion (import-time-side-effect takes precedence for the same access). For each item: the stable dependency name (e.g. "Date.now", "globalThis.fetch"), the specific function or module-level expression that reaches it, a quotable source observation, the exact global/module/loader target a focused test would have to patch, and the natural seam (parameter, port, or factory) that would remove the patch. The mechanical dependency and candidate lists in the request are orientation only — the source is authoritative, and a candidate is not automatically a missing seam (it may sit behind a seam, in a composition root, or in a thin boundary adapter per the rubric).

Every item carries a change direction. For kind "new" every item is "new". For kind "legacy":
- "introduced": the change added this missing seam;
- "worsened": the missing seam existed at base and the change materially deepened it (more call sites, harder to patch);
- "pre-existing": present at base, materially unchanged by this change — residual debt, reported but never blocking.

Assessment semantics (the only valid values; the first two are for kind "new", the next three for kind "legacy"):
- "new-compliant": every dependency of the file's core logic arrives through a seam (or is deterministic local construction, a composition root, or a thin boundary adapter). Requires an empty dependencies_without_seams.
- "new-violating": core logic reaches at least one natural variability boundary without a seam. Requires at least one item, with quotable evidence.
- "improved": the change removed or materially narrowed at least one missing seam and introduced or worsened none. Pre-existing missing seams the head still carries MUST be reported — they become recorded residual debt, they do not block.
- "held": the footprint of missing seams is materially unchanged. Remaining missing seams likewise go in dependencies_without_seams as "pre-existing" residual debt.
- "regressed": the change introduced a missing seam or materially worsened an existing one. Any introduced or worsened item means "regressed" even when another area improved — improvement elsewhere cannot pay for new debt.
- "uncertain": you cannot support any other assessment with quotable evidence. Never guess "new-violating" or "regressed" without evidence.

Dependencies are never failures by themselves: a file whose collaborators all arrive through seams is compliant however many it has. comparison_evidence is the specific before-to-after observation supporting a legacy assessment; for kind "new", set it to "(none — new file)". Keep reasoning_summary to 2-3 sentences.`;
}

export function userPrompt(comparison: Comparison): string {
  const list = (items: string[]): string => (items.length ? items.join('\n') : '(none)');
  const evidence = (label: string, snapshot: Snapshot): string =>
    `${label} dependencies (specifiers):\n${list(snapshot.dependencies)}\n\n${label} ambient-access candidates (mechanical hints, not verdicts):\n${list(snapshot.candidates)}`;
  const { head } = comparison;
  if (comparison.kind === 'new') {
    return `File: ${head.path}
Kind: new (no base version)

${evidence('Head', head)}

<head-content>
${head.content}
</head-content>`;
  }
  const { base } = comparison;
  const renamed = base.path === head.path ? '' : `\nRenamed from: ${base.path}`;
  return `File: ${head.path}
Kind: legacy (base version provided)${renamed}

${evidence('Base', base)}

${evidence('Head', head)}

<base-content>
${base.content}
</base-content>

<head-content>
${head.content}
</head-content>`;
}

interface JudgeComparison {
  assessment: Assessment;
  comparison_evidence: string;
  dependencies_without_seams: SeamDependency[];
  reasoning_summary: string;
}

function isSeamDependency(value: unknown): value is SeamDependency {
  const v = value as SeamDependency;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.dependency === 'string' &&
    (CRITERIA as readonly string[]).includes(v.criterion) &&
    (CHANGES as readonly string[]).includes(v.change) &&
    typeof v.access_point === 'string' &&
    typeof v.evidence === 'string' &&
    typeof v.test_patch === 'string' &&
    typeof v.suggested_seam === 'string'
  );
}

function isJudgeComparison(value: unknown): value is JudgeComparison {
  const v = value as JudgeComparison;
  return (
    typeof v === 'object' &&
    v !== null &&
    (ASSESSMENTS as readonly string[]).includes(v.assessment) &&
    typeof v.comparison_evidence === 'string' &&
    typeof v.reasoning_summary === 'string' &&
    Array.isArray(v.dependencies_without_seams) &&
    v.dependencies_without_seams.every(isSeamDependency)
  );
}

const blank = (text: string): boolean => text.trim().length === 0;

function toViolation(item: SeamDependency): Violation {
  return {
    criterion: item.criterion,
    evidence: `${item.dependency} at ${item.access_point} — ${item.evidence}; a focused test must patch ${item.test_patch}`,
    suggestion: item.suggested_seam,
  };
}

/**
 * Effective-verdict policy: new-compliant → pass; improved/held → pass with
 * pre-existing items retained as residual debt; new-violating and regressed →
 * fail on the blocking items (pre-existing items on a regression stay
 * residual); uncertain → warn. Degradations (ok:false, bad shape, an
 * assessment or item change incompatible with the known kind, a blocking
 * assessment without evidence, blank blocking evidence) map to warn and are
 * not cacheable: they describe the transport or a malformed reply, not the
 * pair, and must retry next run. A judged "uncertain" IS about the pair and
 * caches like any warn.
 */
export function judgeOutcome(comparison: Comparison, result: JudgeResult): { verdict: SeamAuditVerdict; cacheable: boolean } {
  const file = comparison.head.path;
  const degraded = (note: string): { verdict: SeamAuditVerdict; cacheable: boolean } => ({
    verdict: { file, verdict: 'warn', cached: false, violations: [], note, source: 'judge' },
    cacheable: false,
  });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeComparison(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (!KIND_ASSESSMENTS[comparison.kind].includes(judged.assessment)) {
    return degraded(`judge assessed "${judged.assessment}" for a ${comparison.kind} file`);
  }
  const identity: Pick<SeamAuditVerdict, 'assessment' | 'basePath' | 'source'> = {
    assessment: judged.assessment,
    source: 'judge',
    ...(comparison.kind === 'legacy' && comparison.base.path !== file ? { basePath: comparison.base.path } : {}),
  };
  if (judged.assessment === 'uncertain') {
    return {
      cacheable: true,
      verdict: { file, verdict: 'warn', cached: false, violations: [], residualViolations: [], testabilityFootprint: [], ...identity, note: judged.reasoning_summary },
    };
  }
  const items = judged.dependencies_without_seams;
  const badChange = items.find((item) => !KIND_CHANGES[comparison.kind].includes(item.change));
  if (badChange) return degraded(`judge marked a "${badChange.change}" dependency on a ${comparison.kind} file`);
  const blocking = items.filter((item) => BLOCKING_CHANGES.includes(item.change));
  const residual = items.filter((item) => item.change === 'pre-existing');
  const failing = judged.assessment === 'new-violating' || judged.assessment === 'regressed';
  if (failing && blocking.length === 0) return degraded('judge failed without naming a blocking dependency');
  if (!failing && blocking.length > 0) return degraded(`judge assessed "${judged.assessment}" while naming a blocking dependency`);
  if (blocking.some((item) => blank(item.evidence) || blank(item.test_patch))) {
    return degraded('judge named a blocking dependency without evidence');
  }
  if (judged.assessment === 'regressed' && blank(judged.comparison_evidence)) {
    return degraded('judge assessed "regressed" without comparison evidence');
  }
  const note = failing
    ? { note: judged.reasoning_summary }
    : residual.length > 0
      ? { note: `seams ${judged.assessment}; residual missing seams` }
      : {};
  return {
    cacheable: true,
    verdict: {
      file,
      verdict: failing ? 'fail' : 'pass',
      cached: false,
      violations: blocking.map(toViolation),
      residualViolations: residual.map(toViolation),
      testabilityFootprint: items,
      ...identity,
      ...note,
    },
  };
}
