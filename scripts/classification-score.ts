// Scores the classification axis of a recorded qualification run — the
// assessment/verdict call and the criterion labels — with generated prose
// ignored.
//
// The graded self-tests (ACA-0012) fuse two axes into one boolean: did the
// judge classify correctly, AND did it write usable remediation text. That is
// the right gate for shipping a judge, and the wrong measurement for
// comparing one that cannot write at all. A route that returns typed answers
// and probabilities rather than prose fails the strict-schema parse in every
// check's judgeOutcome, degrades to warn, and scores zero — for a reason that
// says nothing about the quality of its judgment.
//
// This reads the same --self-test --json artifacts calibrate.yml already
// uploads, so it re-scores routes measured before it existed and never
// touches a check's grading code. It is a measurement, not a gate:
// qualification remains the fused exam.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SelfTestResultFile {
  /** File stem, used only when the payload does not name its own check. */
  name: string;
  raw: string;
}

export interface ClassificationRow {
  check: string;
  provider: string;
  model: string;
  /** Fixtures the run actually reached and judged. */
  scored: number;
  /** Fixtures the run never reached — the exam short-circuits after a failed
   * level, so these carry no verdict and are absent evidence, not misses. */
  skipped: number;
  assessmentHits: number;
  assessmentAsked: number;
  verdictHits: number;
  verdictAsked: number;
  labelHits: number;
  labelAsked: number;
}

const NOT_A_LABEL = new Set(['assessmentAnyOf', 'verdictAnyOf']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Expected assessments/verdicts, normalized across the two expectation
 * dialects: a single value, or an `...AnyOf` set. An absent constraint means
 * the fixture does not ask about that axis, not that anything satisfies it. */
function expectedSet(expect: Record<string, unknown>, key: string): string[] | undefined {
  const anyOf = expect[`${key}AnyOf`];
  if (isStringArray(anyOf) && anyOf.length > 0) return anyOf;
  const single = expect[key];
  return typeof single === 'string' && single !== '' ? [single] : undefined;
}

/** Every label constraint a fixture carries, whatever the check named it:
 * criteria, criteriaAnyOf, criteriaAllOf, actionsAnyOf, blockingAllOf,
 * residualAllOf, residualCriteriaAnyOf. A name ending in AllOf demands every
 * listed label; anything else demands at least one. Non-label string arrays
 * are excluded by name; nested arrays (agent-rule-conflict's sharedSessions)
 * fail the string-array test on their own. */
function labelConstraints(expect: Record<string, unknown>): { labels: string[]; all: boolean }[] {
  const constraints: { labels: string[]; all: boolean }[] = [];
  for (const [key, value] of Object.entries(expect)) {
    if (NOT_A_LABEL.has(key) || !isStringArray(value) || value.length === 0) continue;
    constraints.push({ labels: value, all: key.endsWith('AllOf') });
  }
  return constraints;
}

/** Every label the judge actually emitted, pooled across the check-specific
 * carriers. Pooling is deliberate: this scores whether the right label fired,
 * not which bucket the check filed it under — that distinction belongs to the
 * fused exam. */
function actualLabels(actual: Record<string, unknown>): Set<string> {
  const labels = new Set<string>();
  for (const [key, value] of Object.entries(actual)) {
    if (key === 'findings') continue;
    if (isStringArray(value)) for (const label of value) labels.add(label);
  }
  const findings = actual['findings'];
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      const criterion = (finding as Record<string, unknown> | null)?.['criterion'];
      if (typeof criterion === 'string') labels.add(criterion);
    }
  }
  return labels;
}

function satisfied(constraint: { labels: string[]; all: boolean }, emitted: Set<string>): boolean {
  return constraint.all ? constraint.labels.every((label) => emitted.has(label)) : constraint.labels.some((label) => emitted.has(label));
}

export function scoreReport(body: Record<string, unknown>, fallbackName: string): ClassificationRow | undefined {
  const fixtures = body['fixtures'];
  // An ungraded check (no manifest) reports only {passed, lines}. There is no
  // per-fixture record to re-score, so it gets no row rather than a zero.
  if (!Array.isArray(fixtures)) return undefined;

  const row: ClassificationRow = {
    check: String(body['check'] ?? fallbackName),
    provider: String(body['provider'] ?? '—'),
    model: String(body['model'] ?? '—'),
    scored: 0,
    skipped: 0,
    assessmentHits: 0,
    assessmentAsked: 0,
    verdictHits: 0,
    verdictAsked: 0,
    labelHits: 0,
    labelAsked: 0,
  };

  for (const entry of fixtures) {
    const fixture = entry as Record<string, unknown>;
    const actual = fixture['actual'];
    if (typeof actual !== 'object' || actual === null) {
      row.skipped += 1;
      continue;
    }
    row.scored += 1;
    const expect = (typeof fixture['expected'] === 'object' && fixture['expected'] !== null ? fixture['expected'] : {}) as Record<string, unknown>;
    const judged = actual as Record<string, unknown>;

    const assessments = expectedSet(expect, 'assessment');
    if (assessments) {
      row.assessmentAsked += 1;
      const got = judged['assessment'];
      if (typeof got === 'string' && assessments.includes(got)) row.assessmentHits += 1;
    }

    const verdicts = expectedSet(expect, 'verdict');
    if (verdicts) {
      row.verdictAsked += 1;
      const got = judged['verdict'];
      if (typeof got === 'string' && verdicts.includes(got)) row.verdictHits += 1;
    }

    const constraints = labelConstraints(expect);
    if (constraints.length > 0) {
      row.labelAsked += 1;
      const emitted = actualLabels(judged);
      if (constraints.every((constraint) => satisfied(constraint, emitted))) row.labelHits += 1;
    }
  }

  return row;
}

function ratio(hits: number, asked: number): string {
  return asked === 0 ? '—' : `${hits}/${asked}`;
}

export function classificationTable(results: readonly SelfTestResultFile[]): string[] {
  const rows: ClassificationRow[] = [];
  const unusable: string[] = [];

  for (const result of results) {
    const raw = result.raw.trim();
    if (raw === '') {
      unusable.push(result.name);
      continue;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      unusable.push(result.name);
      continue;
    }
    const row = scoreReport(body, result.name);
    if (row) rows.push(row);
    else unusable.push(String(body['check'] ?? result.name));
  }

  rows.sort((left, right) => left.check.localeCompare(right.check));

  const lines: string[] = [
    '| check | provider | model | assessment | verdict | labels | scored | not reached |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.check} | ${row.provider} | ${row.model} | ${ratio(row.assessmentHits, row.assessmentAsked)} | ` +
        `${ratio(row.verdictHits, row.verdictAsked)} | ${ratio(row.labelHits, row.labelAsked)} | ${row.scored} | ${row.skipped} |`,
    );
  }

  const totals = rows.reduce(
    (sum, row) => ({
      assessmentHits: sum.assessmentHits + row.assessmentHits,
      assessmentAsked: sum.assessmentAsked + row.assessmentAsked,
      verdictHits: sum.verdictHits + row.verdictHits,
      verdictAsked: sum.verdictAsked + row.verdictAsked,
      labelHits: sum.labelHits + row.labelHits,
      labelAsked: sum.labelAsked + row.labelAsked,
      skipped: sum.skipped + row.skipped,
    }),
    { assessmentHits: 0, assessmentAsked: 0, verdictHits: 0, verdictAsked: 0, labelHits: 0, labelAsked: 0, skipped: 0 },
  );

  lines.push('');
  lines.push(
    `Totals: assessment ${ratio(totals.assessmentHits, totals.assessmentAsked)}, ` +
      `verdict ${ratio(totals.verdictHits, totals.verdictAsked)}, ` +
      `labels ${ratio(totals.labelHits, totals.labelAsked)}.`,
  );
  if (totals.skipped > 0) {
    lines.push('');
    lines.push(`${totals.skipped} fixture(s) were never reached: the graded exam stops after a failed level.`);
    lines.push('Those are absent evidence, not misses — a classification profile from a');
    lines.push('short-circuited run understates every level above the first failure.');
  }
  if (unusable.length > 0) {
    lines.push('');
    lines.push(`No per-fixture record for: ${unusable.join(', ')}.`);
  }
  lines.push('');
  lines.push('Classification axis only: generated prose is ignored, so these numbers are');
  lines.push('NOT qualification. A route qualifies by the fused exam (ACA-0012) or not at all.');
  return lines;
}

function collect(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collect(path));
    else if (entry.endsWith('.json')) found.push(path);
  }
  return found;
}

function main(): void {
  const root = process.argv[2];
  if (root === undefined) {
    console.error('usage: node scripts/classification-score.ts <artifact-dir>');
    process.exit(2);
  }
  let paths: string[] = [];
  try {
    paths = collect(root).sort();
  } catch {
    paths = [];
  }
  const results = paths.map((path) => ({
    name: path.split('/').at(-1)!.replace(/\.json$/, ''),
    raw: readFileSync(path, 'utf8'),
  }));
  for (const line of classificationTable(results)) console.log(line);
}

if (process.argv[1]?.endsWith('classification-score.ts')) main();
