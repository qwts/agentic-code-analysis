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
  /** Expectation keys whose shape this scorer could not read, so a manifest
   * dialect it does not know shows up instead of reading as "not asked". */
  unreadable: string[];
}

const NOT_A_LABEL = new Set(['assessment', 'assessmentAnyOf', 'verdict', 'verdictAnyOf', 'emptyFootprint', 'testNameIncludes']);

/** Seam-audit reports an emitted item as `dependency (criterion)`, so the
 * anchor and the label arrive fused in one string. */
const FORMATTED_ITEM = /^(.+?)\s*\(([^()]*)\)$/;

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

/** One emitted finding, normalized across the three carrier shapes. */
interface EmittedItem {
  criterion?: string;
  /** File(s) or dependency the finding anchors to; empty when the carrier
   * records none. */
  anchors: string[];
  line?: number;
  /** The carrier's own string, for plain string-array dialects. */
  raw: string;
}

/** An expected entry: a bare label, a pair anchor `{criterion, file, line?}`,
 * or a seam-audit footprint entry `{dependency, criterion?}`. */
type ExpectedEntry = string | { criterion?: string; file?: string; line?: number; dependency?: string };

interface LabelConstraint {
  base: string;
  all: boolean;
  entries: ExpectedEntry[];
}

function isEntryObject(value: unknown): value is Exclude<ExpectedEntry, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['criterion'] === 'string' || typeof entry['dependency'] === 'string';
}

/**
 * Every label constraint a fixture carries, whatever the check named it, plus
 * the keys whose shape this scorer cannot read.
 *
 * Three dialects are in use. Plain string arrays (`criteriaAnyOf`,
 * `actionsAnyOf`, `residualCriteriaAnyOf`). Pair-fixture anchors
 * (`criteria: [{criterion, file, line?}]`, which `matchPairExpectation`
 * requires ALL of). Seam-audit footprint entries (`blockingAllOf`,
 * `residualAllOf`, each `{dependency, criterion?}`). An `AllOf` suffix demands
 * every entry; a bare string array demands one; object entries are always
 * all-of, because every dialect that uses them requires all.
 *
 * A key whose value is neither — agent-rule-conflict's `sharedSessions`, or
 * any future shape — is reported rather than dropped. Silently reading an
 * unrecognized constraint as "not asked" is the failure this function exists
 * to avoid (Cursor Bugbot, PR #90).
 */
function labelConstraints(expect: Record<string, unknown>): { constraints: LabelConstraint[]; unreadable: string[] } {
  const constraints: LabelConstraint[] = [];
  const unreadable: string[] = [];
  for (const [key, value] of Object.entries(expect)) {
    if (NOT_A_LABEL.has(key)) continue;
    if (!Array.isArray(value)) {
      // A scalar on an unknown key is still a constraint this scorer does not
      // read: agent-rule-conflict states `sharedSessions: "some"`. Skipping it
      // silently is the same defect as dropping the object dialects, so it is
      // reported rather than ignored.
      if (value !== undefined && value !== null) unreadable.push(key);
      continue;
    }
    if (value.length === 0) continue;
    const base = key.replace(/(AnyOf|AllOf)$/, '');
    if (value.every((entry) => typeof entry === 'string' && entry !== '')) {
      constraints.push({ base, all: key.endsWith('AllOf'), entries: value as string[] });
    } else if (value.every(isEntryObject)) {
      constraints.push({ base, all: true, entries: value as ExpectedEntry[] });
    } else {
      unreadable.push(key);
    }
  }
  return { constraints, unreadable };
}

function emittedFromString(text: string): EmittedItem {
  const match = FORMATTED_ITEM.exec(text);
  if (match) return { criterion: match[2]!, anchors: [match[1]!], raw: text };
  return { criterion: text, anchors: [], raw: text };
}

function emittedFromFinding(finding: Record<string, unknown>): EmittedItem {
  const anchors: string[] = [];
  const file = finding['file'];
  if (typeof file === 'string') anchors.push(file);
  const files = finding['files'];
  if (isStringArray(files)) anchors.push(...files);
  const criterion = finding['criterion'];
  const line = finding['line'];
  return {
    ...(typeof criterion === 'string' ? { criterion } : {}),
    anchors,
    ...(typeof line === 'number' ? { line } : {}),
    raw: typeof criterion === 'string' ? criterion : '',
  };
}

/**
 * The items a constraint is scored against — its own carrier only. Blocking
 * and residual are never pooled: seam-audit's oracle holds that a residual
 * expectation cannot be met by a blocking item, and pooling them would score
 * a judge correct for putting a finding in the wrong bucket.
 */
function emittedFor(actual: Record<string, unknown>, base: string): EmittedItem[] {
  const items: EmittedItem[] = [];
  const direct = actual[base];
  if (isStringArray(direct)) items.push(...direct.map(emittedFromString));
  // Pair checks carry their findings under `findings`, anchored per file.
  if (base === 'criteria' && Array.isArray(actual['findings'])) {
    for (const finding of actual['findings']) {
      if (typeof finding === 'object' && finding !== null && !Array.isArray(finding)) {
        items.push(emittedFromFinding(finding as Record<string, unknown>));
      }
    }
  }
  return items;
}

function entryMatches(entry: ExpectedEntry, items: readonly EmittedItem[]): boolean {
  if (typeof entry === 'string') return items.some((item) => item.criterion === entry || item.raw === entry);
  if (typeof entry.dependency === 'string') {
    // Seam-audit matches a dependency by case-insensitive substring.
    const needle = entry.dependency.toLowerCase();
    return items.some(
      (item) =>
        item.anchors.some((anchor) => anchor.toLowerCase().includes(needle)) && (entry.criterion === undefined || item.criterion === entry.criterion),
    );
  }
  if (typeof entry.criterion === 'string') {
    return items.some(
      (item) =>
        item.criterion === entry.criterion &&
        (entry.file === undefined || item.anchors.includes(entry.file)) &&
        (entry.line === undefined || item.line === entry.line),
    );
  }
  return false;
}

function satisfied(constraint: LabelConstraint, actual: Record<string, unknown>): boolean {
  const items = emittedFor(actual, constraint.base);
  return constraint.all ? constraint.entries.every((entry) => entryMatches(entry, items)) : constraint.entries.some((entry) => entryMatches(entry, items));
}

export function scoreReport(body: Record<string, unknown>, fallbackName: string): ClassificationRow | undefined {
  // Defensive for direct callers: `null` satisfies the declared type at a
  // JSON boundary and would throw on the first property read.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
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
    unreadable: [],
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

    const { constraints, unreadable } = labelConstraints(expect);
    for (const key of unreadable) if (!row.unreadable.includes(key)) row.unreadable.push(key);
    // seam-audit's clean-pass claim: the footprint must be empty. "No label
    // fired" is a classification claim, so it is scored on this axis too.
    const wantsEmpty = expect['emptyFootprint'] === true;
    if (constraints.length > 0 || wantsEmpty) {
      row.labelAsked += 1;
      const emptyOk = !wantsEmpty || (emittedFor(judged, 'blocking').length === 0 && emittedFor(judged, 'residual').length === 0);
      if (emptyOk && constraints.every((constraint) => satisfied(constraint, judged))) row.labelHits += 1;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unusable.push(result.name);
      continue;
    }
    // Valid JSON is not a usable report on its own: `null` parses cleanly and
    // would throw on the first property read, taking every other artifact's
    // result down with it rather than listing this one as unusable (Codex,
    // PR #90). One dead artifact must never suppress the rest of the table.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      unusable.push(result.name);
      continue;
    }
    const body = parsed as Record<string, unknown>;
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
  const unreadable = rows.filter((row) => row.unreadable.length > 0);
  if (unreadable.length > 0) {
    lines.push('');
    lines.push('Expectation keys this scorer cannot read, so they are not scored:');
    for (const row of unreadable) lines.push(`  ${row.check}: ${row.unreadable.join(', ')}`);
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
