// The judge interface of this check: pinned prompt version, strict verdict
// schema, system/user prompt builders, and the mapping from a JudgeResult to
// a FileVerdict. The rule text is embedded verbatim at runtime by the caller —
// never paraphrased here — so the rule and the judge cannot drift apart.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeResult } from '../../core/judge-client.ts';
import type { FileVerdict, Verdict, Violation } from '../registry.ts';
import type { FileFacts } from './derive.ts';

// Bump on ANY prompt change; invalidates the verdict cache by construction.
export const PROMPT_VERSION = 'context-footprint-v1';

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

export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'practical_test_answer', 'violations', 'reasoning_summary'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
    practical_test_answer: { type: 'string' },
    violations: {
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
  return `You judge one source file at a time against a file-organization rule. The rule text, verbatim and authoritative:

<rule>
${ruleText}
</rule>

Judge the file AS IT NOW STANDS — not the diff, not its neighbors. Answer the rule's practical test: what is the smallest set of files a model must load to work on this file's concept safely and correctly?

Load-set accounting:
- An imported file counts toward the load-set only when it must be OPENED to understand this file — when the name at the boundary is enough, it does not count.
- A well-bounded file is comprehensible from its own content plus the names it imports. A short file where nearly every line leans on imported symbols has a LARGE effective footprint despite its line count.
- A leaf file swept into a change is judged on its own footprint, never on a neighbor's problem inherited through the diff.

Verdict semantics:
- "fail" is reserved for clear violations you can name with a criterion and quote evidence for: enumeration/re-export ceremony over content, concerns that are never changed together sharing a file, a split that increased the load-set, context duplicated from files that already own it.
- Ambiguity is "warn", never "fail". If you cannot quote specific evidence for a named criterion, do not fail the file.
- "pass" means the file is independently useful, semantically complete, and narrowly scoped.

Criteria (the only valid violation labels):
- mixed-responsibility: unrelated concerns colocated; a task on one loads the others.
- incomplete-concept: the concept is not comprehensible without opening other files.
- relocation-not-design: content moved to satisfy a metric without reducing the load-set.
- over-fragmentation: a split that increased the number of files a task must load.
- duplicated-context: restates or enumerates what other files already own.

Report violations only for the verdict you give: "fail" requires at least one violation; "pass" requires none. Keep reasoning_summary to 2-3 sentences.`;
}

export function userPrompt(file: string, content: string, facts: FileFacts): string {
  const list = (paths: string[]): string => (paths.length ? paths.join('\n') : '(none)');
  return `File: ${file}
Change: ${facts.growth}

Imports (paths only):
${list(facts.imports)}

Imported by (paths only):
${list(facts.importedBy)}

Diff hunks in this change:
${facts.hunks || '(none)'}

<file-content>
${content}
</file-content>`;
}

interface JudgeVerdict {
  verdict: Verdict;
  practical_test_answer: string;
  violations: Violation[];
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

function isJudgeVerdict(value: unknown): value is JudgeVerdict {
  const v = value as JudgeVerdict;
  return (
    typeof v === 'object' &&
    v !== null &&
    ['pass', 'warn', 'fail'].includes(v.verdict) &&
    typeof v.reasoning_summary === 'string' &&
    typeof v.practical_test_answer === 'string' &&
    Array.isArray(v.violations) &&
    v.violations.every(isViolation)
  );
}

/**
 * Degradations (ok:false, bad shape, fail-without-evidence) map to warn —
 * never a crash, never a silent pass — and are not cacheable: they describe
 * the transport or a malformed reply, not the file, and must retry next run.
 */
export function judgeOutcome(file: string, result: JudgeResult): { verdict: FileVerdict; cacheable: boolean } {
  const degraded = (note: string): { verdict: FileVerdict; cacheable: boolean } => ({
    verdict: { file, verdict: 'warn', cached: false, violations: [], note },
    cacheable: false,
  });
  if (!result.ok) return degraded(result.note);
  if (!isJudgeVerdict(result.verdict)) return degraded('judge output failed schema parse');
  const judged = result.verdict;
  if (judged.verdict === 'fail' && judged.violations.length === 0) {
    return degraded('judge failed without naming a criterion');
  }
  return {
    cacheable: true,
    verdict: {
      file,
      verdict: judged.verdict,
      cached: false,
      violations: judged.violations,
      ...(judged.verdict === 'pass' ? {} : { note: judged.reasoning_summary }),
    },
  };
}
