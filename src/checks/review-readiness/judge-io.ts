// The judge interface of this check: pinned prompt version, strict schema,
// prompt builders, and the mapping from a JudgeResult to one artifact-level
// outcome. The judgment is whole-diff and single-call — "is this change
// ready for human review?" — and intentional items are NOT findings; that
// discrimination is the check. Host code owns policy: anchors are validated
// against the artifact's added-line index, and every malformed reply
// degrades to a non-cacheable warn — never a crash, dropped finding, or
// silent pass (design: docs/design/check-review-readiness.md).
import type { JudgeResult } from '../../core/judge-client.ts';
import type { RenderedPayload } from '../../core/diff-artifact.ts';

// Bump on ANY prompt change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'review-readiness-v1';

// Operational bound (check design): one whole-diff request; 4096 output
// tokens covers a not-ready reply with a dozen anchored findings — a diff
// needing more findings than that has failed for simpler reasons.
export const MAX_TOKENS = 32_768;

export const CRITERIA = [
  'leftover-debug',
  'commented-out-code',
  'unlinked-todo',
  'silenced-test',
  'unexplained-magic-value',
] as const;

export const ASSESSMENTS = ['ready', 'not-ready', 'uncertain'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export interface ReviewFinding {
  criterion: (typeof CRITERIA)[number];
  file: string;
  line: number;
  evidence: string;
  suggestion: string;
}

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'findings', 'reasoning_summary'],
  properties: {
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'file', 'line', 'evidence', 'suggestion'],
        properties: {
          criterion: { type: 'string', enum: [...CRITERIA] },
          file: { type: 'string' },
          line: { type: 'integer' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    reasoning_summary: { type: 'string' },
  },
};

export function systemPrompt(): string {
  return `You judge whether a code change is ready for human review — one judgment over the WHOLE diff. You are the pre-review sweep that catches what the author forgot, so a human reviewer's first pass is not spent on it. You see the change as a reviewer would: several unrelated pieces of leftover debris are one signal of an unswept change.

The diff below shows each changed file. Context and added lines are prefixed with their line number in the resulting (head) file; removed lines are prefixed with "-" and no number. Only ADDED lines (prefix "+") may carry findings — removed and context lines can inform your judgment of intent, but never anchor a finding.

Criteria (the only valid finding labels):
- leftover-debug: a print/dump/trace added to debug this change and forgotten — it served the author, not the code. Deliberate operational logging is NOT a finding.
- commented-out-code: code disabled in place with no explanation. Version history preserves deleted code; an unexplained commented block is indecision, not documentation. A commented block with a stated reason is NOT a finding.
- unlinked-todo: a TODO/FIXME/HACK introduced with no issue link and no actionable context. A TODO carrying a tracker reference or a concrete plan is NOT a finding.
- silenced-test: a test newly skipped, disabled, or emptied without a stated reason. A skip with a reason (linked issue, named flake, pending dependency) is NOT a finding.
- unexplained-magic-value: a load-bearing literal introduced where its meaning is not locally evident — no name, no derivation, no comment. Obvious values in obvious places (0, 1, array indices, test data, well-known ports in config) are NOT findings.

The judgment "intentional or forgotten?" is the entire point — each criterion alone is lintable, telling a deliberate breadcrumb from debris is not. When the surrounding change makes an item clearly deliberate, it is not a finding. When you cannot tell, lean toward reporting only items a reviewer would have to stop and ask about.

Assessment semantics (the only valid values):
- "ready": nothing forgotten — findings MUST be empty.
- "not-ready": at least one finding, each anchored to an added line's shown number, with the offending content quoted in evidence and why it reads forgotten rather than intentional. Suggestions are pre-review fixes the author applies before requesting review ("delete the print", "link the tracking issue", "name the constant") — never review verdicts.
- "uncertain": you cannot support ready or not-ready with quotable evidence — findings MUST be empty.

Style, formatting, whether the change is coherent, and secret detection are all out of scope. Keep reasoning_summary to 2-3 sentences.`;
}

export function userPrompt(payload: RenderedPayload): string {
  return `Changed files: ${payload.included.length ? payload.included.join(', ') : '(none)'}

<diff>
${payload.text}
</diff>`;
}

/**
 * One artifact-level outcome; the check projects it onto per-file verdicts.
 * `cacheable` follows the suite discipline: a judged outcome (including a
 * well-formed "uncertain") describes the diff and caches; a degradation
 * describes the transport or a malformed reply and must retry next run.
 */
export interface ArtifactOutcome {
  assessment?: Assessment;
  verdict: 'pass' | 'warn' | 'fail';
  findings: ReviewFinding[];
  note?: string;
  cacheable: boolean;
}

interface JudgeReply {
  assessment: Assessment;
  findings: ReviewFinding[];
  reasoning_summary: string;
}

function isFinding(value: unknown): value is ReviewFinding {
  const v = value as ReviewFinding;
  return (
    typeof v === 'object' &&
    v !== null &&
    (CRITERIA as readonly string[]).includes(v.criterion) &&
    typeof v.file === 'string' &&
    Number.isInteger(v.line) &&
    typeof v.evidence === 'string' &&
    typeof v.suggestion === 'string'
  );
}

function isJudgeReply(value: unknown): value is JudgeReply {
  const v = value as JudgeReply;
  return (
    typeof v === 'object' &&
    v !== null &&
    (ASSESSMENTS as readonly string[]).includes(v.assessment) &&
    typeof v.reasoning_summary === 'string' &&
    Array.isArray(v.findings) &&
    v.findings.every(isFinding)
  );
}

const nonblank = (text: string): boolean => text.trim().length > 0;

export function judgeOutcome(result: JudgeResult, validAnchors: ReadonlyMap<string, ReadonlySet<number>>): ArtifactOutcome {
  const degraded = (note: string): ArtifactOutcome => ({ verdict: 'warn', findings: [], note, cacheable: false });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeReply(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (judged.assessment !== 'not-ready' && judged.findings.length > 0) {
    return degraded(`judge assessed "${judged.assessment}" while naming findings`);
  }
  if (judged.assessment === 'not-ready') {
    if (judged.findings.length === 0) return degraded('judge failed without naming a finding');
    for (const finding of judged.findings) {
      if (!validAnchors.get(finding.file)?.has(finding.line)) {
        return degraded(`judge anchored ${finding.criterion} to ${finding.file}:${finding.line}, which is not an added line of this diff`);
      }
      if (!nonblank(finding.evidence) || !nonblank(finding.suggestion)) {
        return degraded(`judge reported ${finding.criterion} at ${finding.file}:${finding.line} without evidence or suggestion`);
      }
    }
    return { assessment: 'not-ready', verdict: 'fail', findings: judged.findings, note: judged.reasoning_summary, cacheable: true };
  }
  if (judged.assessment === 'uncertain') {
    return { assessment: 'uncertain', verdict: 'warn', findings: [], note: judged.reasoning_summary, cacheable: true };
  }
  return { assessment: 'ready', verdict: 'pass', findings: [], cacheable: true };
}
