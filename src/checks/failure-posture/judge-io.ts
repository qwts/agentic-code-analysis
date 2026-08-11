// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The rubric is embedded verbatim at runtime — never
// paraphrased here — so the rubric and the judge cannot drift apart. The
// judgment is comparative (ACA-0013): direction of change for legacy files,
// absolute state for new ones; gate policy stays in host code. The judge
// describes concrete misbehavior scenarios — the scenario is the finding,
// the criterion is only its label.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Violation } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';
import type { PrefilterHint } from './prefilter.ts';

// Bump on ANY prompt, rubric, payload, or applicability-rule change that can
// alter judgment routing; invalidates the verdict cache by construction.
// v2: prefilter comment/string tokenizer + subpath import matching changed
// applicability routing and hints (Codex/Copilot reviews, PR #35); prompt
// text itself is unchanged.
export const PROMPT_VERSION = 'failure-posture-v2';

// Operational bound (check design): one file per request, 4096 output tokens.
export const MAX_TOKENS = 32_768;

// The authoritative rubric ships with this package, not the consuming repo.
const RUBRIC_PATH = fileURLToPath(new URL('../../../docs/standards/file-failure-posture.md', import.meta.url));

export function rubricText(): string {
  return readFileSync(RUBRIC_PATH, 'utf8');
}

export const CRITERIA = [
  'missing-timeout',
  'retry-without-backoff',
  'unbounded-retry',
  'swallowed-failure',
  'unbounded-buffering',
  'stampede-prone',
  'unchecked-external-result',
] as const;

export const ASSESSMENTS = ['new-compliant', 'new-violating', 'improved', 'held', 'regressed', 'uncertain'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

/** What each comparison kind may legitimately be assessed as; anything else
 * is a malformed reply, not a verdict. */
const KIND_ASSESSMENTS: Record<Comparison['kind'], readonly Assessment[]> = {
  new: ['new-compliant', 'new-violating', 'uncertain'],
  legacy: ['improved', 'held', 'regressed', 'uncertain'],
};

/**
 * The check's verdict subtype: `violations` stays the blocking evidence;
 * `residualViolations` is nonblocking debt retained on improved/held legacy
 * files; `skipped` marks a mechanical applicability skip that made no judge
 * call. Extends the registry contract structurally — the shared FileVerdict
 * is not widened (ACA-0013).
 */
export interface FailurePostureVerdict extends FileVerdict {
  assessment?: Assessment;
  /** Base identity when it differs from `file` (rename). */
  basePath?: string;
  residualViolations?: Violation[];
  /** Present (true) only when the prefilter skipped the file mechanically. */
  skipped?: true;
}

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'before_failure_posture', 'after_failure_posture', 'comparison_evidence', 'head_violations', 'reasoning_summary'],
  properties: {
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    before_failure_posture: { type: 'string' },
    after_failure_posture: { type: 'string' },
    comparison_evidence: { type: 'string' },
    head_violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'evidence', 'suggestion'],
        properties: {
          criterion: { type: 'string', enum: [...CRITERIA] },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    reasoning_summary: { type: 'string' },
  },
};

export function systemPrompt(rubricText: string): string {
  return `You judge how one source file behaves when its external dependencies misbehave, against a failure-posture rubric. The rubric text, verbatim and authoritative:

<rubric>
${rubricText}
</rubric>

Each request carries one file as either kind "new" (head version only — judge it absolutely against the rubric) or kind "legacy" (base and head versions — judge the DIRECTION of the change, not the head's absolute state). Answer the rubric's practical test for each provided version: for each external dependency this code touches, what does it do when that dependency is slow, down, or lying?

The request may include prefilter hints — mechanical routing signals (matched imports, calls, boundary-like symbols). They are hints, not proof: verify every hint against the code, and judge dependencies the hints missed. A hint alone is never evidence.

Assessment semantics (the only valid values; the first two are for kind "new", the next three for kind "legacy"):
- "new-compliant": every external interaction has a sound failure posture under the rubric. Requires zero head_violations.
- "new-violating": violates the rubric. Requires at least one head_violation with concrete scenario evidence.
- "improved": the head's failure posture is materially safer than the base's, and no criterion was introduced or materially worsened. Violations the head still carries MUST be reported in head_violations — they become recorded residual debt, they do not block.
- "held": posture materially unchanged. Remaining violations likewise go in head_violations as residual debt.
- "regressed": the change introduced a violation or materially worsened an existing one. Any introduced or materially worsened criterion means "regressed" even when another area improved — improvement elsewhere cannot pay for new risk. Requires at least one head_violation naming what got worse, with comparison_evidence stating the before-to-after difference.
- "uncertain": you cannot support any other assessment with concrete evidence. Unknown SDK or wrapper behavior is "uncertain", never a guessed failure.

head_violations always describe the HEAD version only. Each violation's evidence must be the concrete misbehavior scenario, anchored to the code: IF this dependency is slow/down/wrong, THIS code responds (or fails to respond) in this way, CAUSING this observable impact. Example shape: "if this endpoint hangs, every worker thread blocks forever". The scenario is the finding; the criterion is only its label. Never emit a bare label with generic evidence.

Respect the rubric's non-violations: a caller-provided signal or explicitly configured client policy satisfies the deadline requirement; long-lived streams need lifecycle/cancellation, not arbitrary request timeouts; a bounded fallback or declared best-effort telemetry is not swallowed-failure; do not demand validation of results with no file-visible contract.

Security boundary (strict): report ONLY operational consequences — availability, latency/resource exhaustion, durability/data loss, false operational success, stale/corrupt operational state. Authentication or authorization failing open, privileged work continuing after failure, trust-boundary bypass, and secret/PII exposure belong to a separate security check: never report them here, even when you notice them. If one code path also has an independent operational consequence, report only the operational scenario.

before_failure_posture is the practical-test answer for the base version; comparison_evidence is the specific before-to-after observation supporting your assessment. For kind "new", set both to "(none — new file)". Keep reasoning_summary to 2-3 sentences.`;
}

const hintLines = (hints: PrefilterHint[]): string =>
  hints.length ? hints.map((h) => `${h.kind}/${h.source}: ${h.token}`).join('\n') : '(none)';

export function userPrompt(comparison: Comparison, hints: { head: PrefilterHint[]; base?: PrefilterHint[] }): string {
  const list = (paths: string[]): string => (paths.length ? paths.join('\n') : '(none)');
  const graph = (label: string, snapshot: Snapshot): string =>
    `${label} imports (paths only):\n${list(snapshot.imports)}\n\n${label} imported by (paths only):\n${list(snapshot.importedBy)}`;
  const { head } = comparison;
  if (comparison.kind === 'new') {
    return `File: ${head.path}
Kind: new (no base version)
Change: ${comparison.growth}

Prefilter hints for head (routing hints, not proof):
${hintLines(hints.head)}

${graph('Head', head)}

<head-content>
${head.content}
</head-content>`;
  }
  const { base } = comparison;
  const renamed = base.path === head.path ? '' : `\nRenamed from: ${base.path}`;
  return `File: ${head.path}
Kind: legacy (base version provided)${renamed}
Change: ${comparison.growth}

Prefilter hints for base (routing hints, not proof):
${hintLines(hints.base ?? [])}

Prefilter hints for head (routing hints, not proof):
${hintLines(hints.head)}

${graph('Base', base)}

${graph('Head', head)}

<base-content>
${base.content}
</base-content>

<head-content>
${head.content}
</head-content>`;
}

interface JudgeComparison {
  assessment: Assessment;
  before_failure_posture: string;
  after_failure_posture: string;
  comparison_evidence: string;
  head_violations: Violation[];
  reasoning_summary: string;
}

function isViolation(value: unknown): value is Violation {
  const v = value as Violation;
  return (
    typeof v === 'object' &&
    v !== null &&
    (CRITERIA as readonly string[]).includes(v.criterion) &&
    typeof v.evidence === 'string' &&
    typeof v.suggestion === 'string'
  );
}

function isJudgeComparison(value: unknown): value is JudgeComparison {
  const v = value as JudgeComparison;
  return (
    typeof v === 'object' &&
    v !== null &&
    (ASSESSMENTS as readonly string[]).includes(v.assessment) &&
    typeof v.before_failure_posture === 'string' &&
    typeof v.after_failure_posture === 'string' &&
    typeof v.comparison_evidence === 'string' &&
    typeof v.reasoning_summary === 'string' &&
    Array.isArray(v.head_violations) &&
    v.head_violations.every(isViolation)
  );
}

/**
 * Effective-verdict policy (ACA-0013): new-compliant → pass; improved/held →
 * pass with head_violations retained as residual debt; new-violating and
 * regressed → fail on the same evidence; uncertain → warn. Degradations
 * (ok:false, bad shape, blocking assessment without evidence or with blank
 * scenario evidence, assessment incompatible with the known kind) map to
 * warn and are not cacheable: they describe the transport or a malformed
 * reply, not the pair, and must retry next run. A judged "uncertain" IS
 * about the pair and caches like any warn. A criterion outside the closed
 * reliability set (e.g. a security label) cannot arrive — the schema and
 * isViolation both reject it as malformed.
 */
export function judgeOutcome(comparison: Comparison, result: JudgeResult): { verdict: FailurePostureVerdict; cacheable: boolean } {
  const file = comparison.head.path;
  const degraded = (note: string): { verdict: FailurePostureVerdict; cacheable: boolean } => ({
    verdict: { file, verdict: 'warn', cached: false, violations: [], note },
    cacheable: false,
  });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeComparison(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (!KIND_ASSESSMENTS[comparison.kind].includes(judged.assessment)) {
    return degraded(`judge assessed "${judged.assessment}" for a ${comparison.kind} file`);
  }
  const blocking = judged.assessment === 'new-violating' || judged.assessment === 'regressed';
  if (blocking && judged.head_violations.length === 0) {
    return degraded('judge failed without naming a criterion');
  }
  if (blocking && judged.head_violations.some((v) => v.evidence.trim() === '')) {
    // The scenario is the finding; a blank one is a malformed reply.
    return degraded('judge failed without scenario evidence');
  }
  if (judged.assessment === 'new-compliant' && judged.head_violations.length > 0) {
    return degraded('judge passed while naming violations');
  }
  const identity: Pick<FailurePostureVerdict, 'assessment' | 'basePath'> = {
    assessment: judged.assessment,
    ...(comparison.kind === 'legacy' && comparison.base.path !== file ? { basePath: comparison.base.path } : {}),
  };
  if (judged.assessment === 'improved' || judged.assessment === 'held') {
    const residuals = judged.head_violations;
    return {
      cacheable: true,
      verdict: {
        file,
        verdict: 'pass',
        cached: false,
        violations: [],
        residualViolations: residuals,
        ...identity,
        ...(residuals.length > 0 ? { note: `posture ${judged.assessment}; residual debt` } : {}),
      },
    };
  }
  if (judged.assessment === 'uncertain') {
    return {
      cacheable: true,
      verdict: { file, verdict: 'warn', cached: false, violations: [], residualViolations: [], ...identity, note: judged.reasoning_summary },
    };
  }
  return {
    cacheable: true,
    verdict: {
      file,
      verdict: blocking ? 'fail' : 'pass',
      cached: false,
      violations: judged.head_violations,
      residualViolations: [],
      ...identity,
      ...(blocking ? { note: judged.reasoning_summary } : {}),
    },
  };
}
