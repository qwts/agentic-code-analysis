// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The rule text is embedded verbatim at runtime by the caller —
// never paraphrased here — so the rule and the judge cannot drift apart.
// Since v2 (ACA-0013) the judgment is comparative: the judge assesses the
// direction of change for legacy files and absolute state only for new ones;
// gate policy (which assessment blocks) stays in host code.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Violation } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';

// Bump on ANY prompt change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'context-footprint-v2';

// Operational bound (check design): one file per request, 4096 output tokens.
export const MAX_TOKENS = 4096;

// The vendored rule ships with this package, not the consuming repo.
const RULE_PATH = fileURLToPath(new URL('../../../docs/standards/file-context-footprint.md', import.meta.url));

export function ruleText(): string {
  return readFileSync(RULE_PATH, 'utf8');
}

export const CRITERIA = [
  'mixed-responsibility',
  'incomplete-concept',
  'relocation-not-design',
  'over-fragmentation',
  'duplicated-context',
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
 * files. Extends the registry contract structurally — the shared FileVerdict
 * is not widened (ACA-0013).
 */
export interface ContextFootprintVerdict extends FileVerdict {
  assessment?: Assessment;
  /** Base identity when it differs from `file` (rename). */
  basePath?: string;
  residualViolations?: Violation[];
}

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'before_practical_test', 'after_practical_test', 'comparison_evidence', 'head_violations', 'reasoning_summary'],
  properties: {
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    before_practical_test: { type: 'string' },
    after_practical_test: { type: 'string' },
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

export function systemPrompt(ruleText: string): string {
  return `You judge how one source file changed, against a file-organization rule. The rule text, verbatim and authoritative:

<rule>
${ruleText}
</rule>

Each request carries one file as either kind "new" (head version only — judge it absolutely against the rule) or kind "legacy" (base and head versions — judge the DIRECTION of the change, not the head's absolute state). Answer the rule's practical test for each provided version: what is the smallest set of files a model must load to work on this file's concept safely and correctly?

Load-set accounting:
- An imported file counts toward the load-set only when it must be OPENED to understand this file — when the name at the boundary is enough, it does not count.
- A well-bounded file is comprehensible from its own content plus the names it imports. A short file where nearly every line leans on imported symbols has a LARGE effective footprint despite its line count.
- A leaf file swept into a change is judged on its own footprint, never on a neighbor's problem inherited through the diff.

Assessment semantics (the only valid values; the first two are for kind "new", the next three for kind "legacy"):
- "new-compliant": independently useful, semantically complete, narrowly scoped. Requires zero head_violations.
- "new-violating": violates the rule. Requires at least one head_violation with quoted evidence.
- "improved": the head's context footprint is materially smaller than the base's, and no criterion was introduced or materially worsened. Violations the head still carries MUST be reported in head_violations — they become recorded residual debt, they do not block.
- "held": footprint materially unchanged. Remaining violations likewise go in head_violations as residual debt.
- "regressed": the change introduced a violation or materially worsened an existing one. Any introduced or materially worsened criterion means "regressed" even when another area improved — improvement elsewhere cannot pay for new debt. Requires at least one head_violation naming what got worse, with comparison_evidence stating the before-to-after difference.
- "uncertain": you cannot support any other assessment with quotable evidence. Never guess "new-violating" or "regressed" without evidence.

head_violations always describe the HEAD version only. Line counts and diff size are orientation, not the decision: a file can shrink and regress, or grow and improve. Comparative judgment is about the load-set, not the line count.

Criteria (the only valid violation labels):
- mixed-responsibility: unrelated concerns colocated; a task on one loads the others.
- incomplete-concept: the concept is not comprehensible without opening other files.
- relocation-not-design: content moved to satisfy a metric without reducing the load-set.
- over-fragmentation: a split that increased the number of files a task must load.
- duplicated-context: restates or enumerates what other files already own.

before_practical_test is the practical-test answer for the base version; comparison_evidence is the specific before-to-after observation supporting your assessment. For kind "new", set both to "(none — new file)". Keep reasoning_summary to 2-3 sentences.`;
}

export function userPrompt(comparison: Comparison): string {
  const list = (paths: string[]): string => (paths.length ? paths.join('\n') : '(none)');
  const graph = (label: string, snapshot: Snapshot): string =>
    `${label} imports (paths only):\n${list(snapshot.imports)}\n\n${label} imported by (paths only):\n${list(snapshot.importedBy)}`;
  const { head } = comparison;
  if (comparison.kind === 'new') {
    return `File: ${head.path}
Kind: new (no base version)
Change: ${comparison.growth}

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
  before_practical_test: string;
  after_practical_test: string;
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
    typeof v.before_practical_test === 'string' &&
    typeof v.after_practical_test === 'string' &&
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
 * (ok:false, bad shape, blocking assessment without evidence, assessment
 * incompatible with the known kind) map to warn and are not cacheable: they
 * describe the transport or a malformed reply, not the pair, and must retry
 * next run. A judged "uncertain" IS about the pair and caches like any warn.
 */
export function judgeOutcome(comparison: Comparison, result: JudgeResult): { verdict: ContextFootprintVerdict; cacheable: boolean } {
  const file = comparison.head.path;
  const degraded = (note: string): { verdict: ContextFootprintVerdict; cacheable: boolean } => ({
    verdict: { file, verdict: 'warn', cached: false, violations: [], note },
    cacheable: false,
  });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeComparison(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (!KIND_ASSESSMENTS[comparison.kind].includes(judged.assessment)) {
    return degraded(`judge assessed "${judged.assessment}" for a ${comparison.kind} file`);
  }
  if ((judged.assessment === 'new-violating' || judged.assessment === 'regressed') && judged.head_violations.length === 0) {
    return degraded('judge failed without naming a criterion');
  }
  if (judged.assessment === 'new-compliant' && judged.head_violations.length > 0) {
    return degraded('judge passed while naming violations');
  }
  const identity: Pick<ContextFootprintVerdict, 'assessment' | 'basePath'> = {
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
        ...(residuals.length > 0 ? { note: `footprint ${judged.assessment}; residual debt` } : {}),
      },
    };
  }
  if (judged.assessment === 'uncertain') {
    return {
      cacheable: true,
      verdict: { file, verdict: 'warn', cached: false, violations: [], residualViolations: [], ...identity, note: judged.reasoning_summary },
    };
  }
  const failed = judged.assessment === 'new-violating' || judged.assessment === 'regressed';
  return {
    cacheable: true,
    verdict: {
      file,
      verdict: failed ? 'fail' : 'pass',
      cached: false,
      violations: judged.head_violations,
      residualViolations: [],
      ...identity,
      ...(failed ? { note: judged.reasoning_summary } : {}),
    },
  };
}
