// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The human-reviewed rubric is embedded verbatim at runtime —
// never paraphrased here — so the rubric and the judge cannot drift apart.
// The judge describes (honest/dishonest/uncertain); gate policy stays in
// host code (check design: Judge output).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict } from '../registry.ts';
import { externalSnapshotUnresolved, type Evidence } from './unit-context.ts';

// Bump on ANY prompt or rubric change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'test-honesty-v1';

// Operational bound (check design): one file per request, 4096 output tokens.
export const MAX_TOKENS = 32_768;

const RUBRIC_PATH = fileURLToPath(new URL('./rubric.md', import.meta.url));

export function rubricText(): string {
  return readFileSync(RUBRIC_PATH, 'utf8');
}

export const CRITERIA = ['asserts-own-mock', 'tautology', 'no-meaningful-assertion', 'unreviewable-snapshot'] as const;

export const ASSESSMENTS = ['honest', 'dishonest', 'uncertain'] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export interface Finding {
  test: string;
  criterion: (typeof CRITERIA)[number];
  evidence: string;
  meaningful_assertion: string;
}

/**
 * The check's verdict subtype (the shared FileVerdict is not widened):
 * findings keep the judged test names as structured data, and context makes
 * the changed-test-file bound auditable in --json.
 */
export interface TestHonestyVerdict extends FileVerdict {
  assessment?: Assessment;
  findings?: Finding[];
  context?: { mode: Evidence['mode']; sources: string[] };
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
        required: ['test', 'criterion', 'evidence', 'meaningful_assertion'],
        properties: {
          test: { type: 'string' },
          criterion: { type: 'string', enum: [...CRITERIA] },
          evidence: { type: 'string' },
          meaningful_assertion: { type: 'string' },
        },
      },
    },
    reasoning_summary: { type: 'string' },
  },
};

export function systemPrompt(rubricText: string): string {
  return `You judge one test file against a test-honesty rubric. The rubric, verbatim and authoritative:

<rubric>
${rubricText}
</rubric>

Each request carries one test file, the export surface of its likely unit(s) under test when resolvable, external snapshot content when resolvable, and explicit markers for evidence that could not be resolved. Judge only what you can see.

Assessment semantics (the only valid values):
- "honest": every test in the file could fail for the right reason if the behavior it names broke. Requires zero findings.
- "dishonest": at least one test cannot fail meaningfully. Requires at least one finding naming the exact test, the criterion, why it cannot fail for the right reason, and what a discriminating assertion would establish.
- "uncertain": you cannot support either judgment with concrete evidence. Never guess "dishonest".

For each finding, "test" is the exact declared test name or, when unnamed, the source expression; "evidence" states the false oracle concretely (quote the assertion or mock wiring); "meaningful_assertion" states what a discriminating assertion would establish about the named behavior. Keep reasoning_summary to 2-3 sentences.`;
}

export function userPrompt(evidence: Evidence): string {
  const units = evidence.units.length
    ? evidence.units.map((unit) => `Unit under test: ${unit.path}\nExport surface:\n${unit.exports.join('\n') || '(no exports found)'}`).join('\n\n')
    : '(no unit context)';
  const snapshots = evidence.snapshots.length
    ? evidence.snapshots.map((snapshot) => `External snapshot: ${snapshot.path}\n<snapshot-content>\n${snapshot.content}\n</snapshot-content>`).join('\n\n')
    : '(no external snapshots)';
  const unavailable = evidence.unavailable.length ? evidence.unavailable.join('\n') : '(none)';
  return `Test file: ${evidence.file}

${units}

${snapshots}

Unavailable evidence:
${unavailable}

<test-content>
${evidence.content}
</test-content>`;
}

interface JudgeReply {
  assessment: Assessment;
  findings: Finding[];
  reasoning_summary: string;
}

function isFinding(value: unknown): value is Finding {
  const f = value as Finding;
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof f.test === 'string' &&
    f.test !== '' &&
    (CRITERIA as readonly string[]).includes(f.criterion) &&
    typeof f.evidence === 'string' &&
    f.evidence !== '' &&
    // The remediation text of a finding: a fail with no actionable fix is a
    // malformed reply, not a verdict (Codex review, PR #32).
    typeof f.meaningful_assertion === 'string' &&
    f.meaningful_assertion.trim() !== ''
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

/**
 * Effective-verdict policy (check design): honest → pass; dishonest with
 * complete findings → fail on that evidence; a judged "uncertain" IS about
 * the file and caches like any warn. Degradations (transport failure, bad
 * shape, dishonest without findings, honest with findings) map to warn and
 * are not cacheable — they must retry next run. One deterministic backstop:
 * a dishonest built entirely on unreviewable-snapshot when no external
 * snapshot content was resolvable becomes a cacheable warn — missing
 * evidence cannot support a fail.
 */
export function judgeOutcome(evidence: Evidence, result: JudgeResult): { verdict: TestHonestyVerdict; cacheable: boolean } {
  const file = evidence.file;
  const context: TestHonestyVerdict['context'] = {
    mode: evidence.mode,
    sources: [...evidence.units.map((u) => u.path), ...evidence.snapshots.map((s) => s.path)],
  };
  const degraded = (note: string): { verdict: TestHonestyVerdict; cacheable: boolean } => ({
    verdict: { file, verdict: 'warn', cached: false, violations: [], context, note },
    cacheable: false,
  });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeReply(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (judged.assessment === 'dishonest' && judged.findings.length === 0) return degraded('judge failed without naming a finding');
  if (judged.assessment === 'honest' && judged.findings.length > 0) return degraded('judge passed while naming findings');
  if (judged.assessment === 'uncertain') {
    return {
      cacheable: true,
      verdict: { file, verdict: 'warn', cached: false, violations: [], assessment: judged.assessment, findings: [], context, note: judged.reasoning_summary },
    };
  }
  if (
    judged.assessment === 'dishonest' &&
    externalSnapshotUnresolved(evidence) &&
    judged.findings.every((finding) => finding.criterion === 'unreviewable-snapshot')
  ) {
    return {
      cacheable: true,
      verdict: {
        file,
        verdict: 'warn',
        cached: false,
        violations: [],
        assessment: judged.assessment,
        findings: judged.findings,
        context,
        note: 'unresolved external snapshot cannot support unreviewable-snapshot',
      },
    };
  }
  const failed = judged.assessment === 'dishonest';
  return {
    cacheable: true,
    verdict: {
      file,
      verdict: failed ? 'fail' : 'pass',
      cached: false,
      // Renderer mapping (check design): evidence leads with the test name,
      // suggestion carries the meaningful assertion — no CLI special-casing.
      violations: judged.findings.map((finding) => ({
        criterion: finding.criterion,
        evidence: `${finding.test}: ${finding.evidence}`,
        suggestion: finding.meaningful_assertion,
      })),
      assessment: judged.assessment,
      findings: judged.findings,
      context,
      ...(failed ? { note: judged.reasoning_summary } : {}),
    },
  };
}
