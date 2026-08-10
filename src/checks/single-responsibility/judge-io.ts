// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The rule text is embedded verbatim at runtime by the caller —
// never paraphrased here — so the rule and the judge cannot drift apart.
// Judgment is comparative per ACA-0013: direction of change for legacy files,
// absolute state only for new ones; gate policy stays in host code.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Violation } from '../registry.ts';
import type { Comparison, Snapshot } from './comparison.ts';

// Bump on ANY prompt change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'single-responsibility-v1';

// Operational bound (check design): one file per request, 4096 output tokens.
export const MAX_TOKENS = 32_768;

// Repo-authored rule — this repo IS the canonical source (check design).
const RULE_PATH = fileURLToPath(new URL('../../../docs/standards/file-single-responsibility.md', import.meta.url));

export function ruleText(): string {
  return readFileSync(RULE_PATH, 'utf8');
}

/** Disjoint by design from the context-footprint criteria — a file failing
 * both checks gets one finding from each, never a shared label. */
export const CRITERIA = ['multiple-actors', 'mixed-concerns', 'change-magnet'] as const;

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
export interface SingleResponsibilityVerdict extends FileVerdict {
  assessment?: Assessment;
  /** Base identity when it differs from `file` (rename). */
  basePath?: string;
  residualViolations?: Violation[];
}

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'before_responsibility', 'after_responsibility', 'comparison_evidence', 'head_violations', 'reasoning_summary'],
  properties: {
    assessment: { type: 'string', enum: [...ASSESSMENTS] },
    before_responsibility: { type: 'string' },
    after_responsibility: { type: 'string' },
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
  return `You judge how one source file changed, against a single-responsibility rule. The rule text, verbatim and authoritative:

<rule>
${ruleText}
</rule>

Each request carries one file as either kind "new" (head version only — judge it absolutely against the rule) or kind "legacy" (base and head versions — judge the DIRECTION of the change, not the head's absolute state). Answer the rule's practical test for each provided version: who can ask for changes to this file, and can any two of them ask independently?

Actor accounting:
- An actor is a person, team, policy, or stakeholder group whose needs can force this file to change. Identify actors from what the code serves — a display surface, a compliance policy, a protocol owner — never from surface features like function count.
- Multiple functions, classes, exports, imports, or callers are NOT violations by themselves. A widely imported file still serves one actor when one owner decides all its changes.
- Cohesive orchestration is one responsibility: a file sequencing parse → validate → dispatch owns the sequence; the steps own themselves. Technical layering alone is not a violation without a divergent reason to change.
- The imported-by paths are evidence of consumer diversity — importers from unrelated areas can reveal a second actor — but a wide caller set alone is never sufficient evidence.
- This is not a judgment about reading cost or file size; a separate check owns context footprint. Judge only the reasons the file can change.

Assessment semantics (the only valid values; the first two are for kind "new", the next three for kind "legacy"):
- "new-compliant": one coherent responsibility — one actor, one reason to change. Requires zero head_violations.
- "new-violating": violates the rule. Requires at least one head_violation whose evidence names the actors, concerns, or structure concretely.
- "improved": the head serves fewer independent change pressures than the base — a concern or actor moved out — and no criterion was introduced or materially worsened. Violations the head still carries MUST be reported in head_violations — they become recorded residual debt, they do not block.
- "held": the responsibility boundary is materially unchanged. Remaining violations likewise go in head_violations as residual debt.
- "regressed": the change introduced a violation or materially worsened an existing one. Any introduced or materially worsened criterion means "regressed" even when another area improved — improvement elsewhere cannot pay for new debt. Requires at least one head_violation naming what got worse, with comparison_evidence stating the before-to-after difference.
- "uncertain": you cannot support any other assessment with concrete, quotable evidence. Never guess "new-violating" or "regressed" without evidence.

head_violations always describe the HEAD version only. Line counts and diff size are orientation, not the decision.

Criteria (the only valid violation labels):
- multiple-actors: two or more identifiable actors or stakeholder groups can request independent changes; the evidence must name the actors and the concrete change each would request. This is the most specific criterion — prefer it whenever the actors can be named.
- mixed-concerns: independent policies or technical concerns change for different reasons, where a distinct actor boundary cannot be supported. Never emit both mixed-concerns and multiple-actors from the same evidence.
- change-magnet: a centralized switch, registry, or enumeration forces unrelated feature additions to edit this file; the evidence must point at the concrete structure, never at guessed change history.

before_responsibility is the practical-test answer for the base version; after_responsibility for the head. For kind "new", set before_responsibility to "(none — new file)". comparison_evidence is the specific before-to-after observation supporting your assessment; for kind "new", "(none — new file)". Keep reasoning_summary to 2-3 sentences.`;
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
  before_responsibility: string;
  after_responsibility: string;
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
    typeof v.before_responsibility === 'string' &&
    typeof v.after_responsibility === 'string' &&
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
export function judgeOutcome(comparison: Comparison, result: JudgeResult): { verdict: SingleResponsibilityVerdict; cacheable: boolean } {
  const file = comparison.head.path;
  const degraded = (note: string): { verdict: SingleResponsibilityVerdict; cacheable: boolean } => ({
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
  const identity: Pick<SingleResponsibilityVerdict, 'assessment' | 'basePath'> = {
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
        ...(residuals.length > 0 ? { note: `responsibility ${judged.assessment}; residual debt` } : {}),
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
