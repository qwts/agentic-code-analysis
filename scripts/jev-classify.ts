// Spike (ACA-0080): measure a System One route's classification axis against
// the test-honesty calibration fixtures.
//
// This is deliberately NOT a JudgeClient. ACA-0080 holds that a route which
// cannot emit the verdict artifact is never admitted as one, and that no
// adapter may synthesize the prose fields to satisfy the parser. So this
// never calls judgeOutcome and never fabricates `evidence`,
// `meaningful_assertion` or `note`. It asks the typed questions directly —
// the assessment and verdict as Choices over the check's own label sets, each
// criterion as a Noul — and writes the result in the --self-test --json shape
// that scripts/classification-score.ts already reads.
//
// It also runs every level rather than short-circuiting after a failed one.
// The exam stops early because higher levels cannot repair a lower miss and
// would only add spend; a classification profile wants the opposite, since a
// short-circuited run understates every level above the first failure.
//
// Output is a measurement, never qualification.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { validateManifest, type CalibrationFixture } from '../src/checks/test-honesty/calibration.ts';
import { ASSESSMENTS, CRITERIA, PROMPT_VERSION, rubricText, systemPrompt, userPrompt } from '../src/checks/test-honesty/judge-io.ts';
import { CONCURRENCY, mapPool } from '../src/checks/test-honesty/pool.ts';
import type { Evidence } from '../src/checks/test-honesty/unit-context.ts';

const FIXTURES_DIR = new URL('../src/checks/test-honesty/fixtures/', import.meta.url);

/** A Noul at or above this probability counts as the criterion being filed.
 * 0.5 is the neutral reading and the honest default for a first measurement:
 * any other cutoff tunes the number before anyone has seen it. */
export const NOUL_THRESHOLD = 0.5;

/** Question name for a criterion's Noul. Built from the criterion itself so a
 * label added to judge-io.ts is asked without editing this file. */
export function noulKey(criterion: string): string {
  return `criterion_${criterion.replaceAll('-', '_')}`;
}

/** The criteria a run filed: every label whose Noul cleared the threshold, in
 * the check's own declared order rather than the order answers arrived. */
export function criteriaFrom(nouls: Record<string, number>, threshold: number = NOUL_THRESHOLD): string[] {
  return CRITERIA.filter((criterion) => (nouls[noulKey(criterion)] ?? 0) >= threshold);
}

/** Grade one fixture the way the manifest asks: an absent constraint is not
 * asked, never automatically satisfied. Mirrors matchExpectation's reading of
 * criteriaAnyOf without importing the verdict-shaped matcher, which expects
 * prose this route does not emit. */
export function gradeFixture(
  expect: { assessment: string; verdict: string; criteriaAnyOf?: string[] },
  actual: { assessment: string; verdict: string; criteria: string[] },
): 'ok' | 'miss' {
  if (expect.assessment !== actual.assessment) return 'miss';
  if (expect.verdict !== actual.verdict) return 'miss';
  if (expect.criteriaAnyOf && !expect.criteriaAnyOf.some((c) => actual.criteria.includes(c))) return 'miss';
  return 'ok';
}

function resolveApiKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(homedir(), '.config', 'typesafe', 'api-key');
  try {
    const fromFile = readFileSync(path, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through to the single actionable message below
  }
  throw new Error(`no TypeSafe API key — set TYPESAFE_API_KEY or write it to ${path}`);
}

function evidenceOf(fixture: CalibrationFixture, contentOf: (file: string) => string | undefined): Evidence {
  return {
    file: fixture.file,
    content: contentOf(fixture.content)!,
    mode: fixture.units.length > 0 ? 'unit-exports' : 'test-only',
    units: fixture.units,
    snapshots: fixture.snapshots,
    unavailable: fixture.unavailable,
  };
}

/** The typed questions, built from the check's own label sets so a criterion
 * added to judge-io.ts appears here without editing this file. */
function questionsFor() {
  const criteriaNouls = Object.fromEntries(
    CRITERIA.map((criterion) => [
      noulKey(criterion),
      noul(`Does this test file exhibit "${criterion}", as the rubric defines it?`),
    ]),
  );
  return {
    assessment: choice(
      'Judged against the rubric, is this test file honest?',
      Object.fromEntries(ASSESSMENTS.map((a) => [a, null])) as Record<(typeof ASSESSMENTS)[number], null>,
    ),
    verdict: choice('What verdict should this file receive?', { pass: null, warn: null, fail: null }),
    ...criteriaNouls,
  };
}

interface FixtureRow {
  name: string;
  level: string;
  status: 'ok' | 'miss';
  expected: unknown;
  actual: { assessment: string; verdict: string; criteria: string[] };
  /** The model string the server returned and the tokens it billed. Recorded
   * per fixture so the artifact evidences its own provenance: without these
   * the row's `model` is only what this script wrote down, which is not proof
   * that any request was served. */
  served: { model: string; usage: unknown };
  /** Kept beside the row so a bad number can be read as calibration rather
   * than re-run: the scorer ignores these. */
  probabilities: Record<string, unknown>;
  confidence: { assessment: number; verdict: number };
}

async function main(): Promise<void> {
  process.env.TYPESAFE_API_KEY = resolveApiKey();
  const model = process.argv[2] ?? 'jev-1';
  const outDir = process.argv[3] ?? 'jev-artifacts';

  const rubric = rubricText();
  const system = systemPrompt(rubric);

  const manifestText = readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8');
  const contents = new Map<string, string>();
  const contentOf = (file: string): string | undefined => {
    if (!contents.has(file)) {
      try {
        contents.set(file, readFileSync(fileURLToPath(new URL(file, FIXTURES_DIR)), 'utf8'));
      } catch {
        return undefined;
      }
    }
    return contents.get(file);
  };
  const manifest = validateManifest(JSON.parse(manifestText), contentOf);

  const client = new TypeSafeClient();
  const questions = questionsFor();

  // Every fixture, every level — see the header on why this does not
  // short-circuit the way the exam does.
  const rows = await mapPool(manifest.fixtures, CONCURRENCY, async (fixture): Promise<FixtureRow> => {
    const evidence = evidenceOf(fixture, contentOf);
    const { answers, model: served, usage } = await client.systemOne({
      state: { rubric: system, evidence: userPrompt(evidence) },
      questions,
    });

    // The Noul keys are built dynamically, so they fall outside the inferred
    // answers type; read them through one narrowed view rather than casting
    // at each use.
    const byName = answers as Record<string, { noul?: number } | undefined>;
    const nouls = Object.fromEntries(CRITERIA.map((c) => [noulKey(c), byName[noulKey(c)]?.noul ?? 0]));

    const criteria = criteriaFrom(nouls);
    const actual = {
      assessment: (answers.assessment as { choice: string }).choice,
      verdict: (answers.verdict as { choice: string }).choice,
      criteria,
    };

    return {
      name: fixture.name,
      level: fixture.level,
      status: gradeFixture(fixture.expect, actual),
      expected: fixture.expect,
      actual,
      served: { model: served, usage },
      probabilities: {
        assessment: (answers.assessment as { probabilities: unknown }).probabilities,
        verdict: (answers.verdict as { probabilities: unknown }).probabilities,
        criteria: Object.fromEntries(CRITERIA.map((c) => [c, nouls[noulKey(c)]])),
      },
      // Confidence is a distinct axis from probability, and it is the one a
      // confidence-gated screen (ACA-0080) would threshold on — a route can
      // be near-even between two labels yet certain that the call is close.
      // Recorded per axis so a threshold can be chosen from evidence rather
      // than inferred from the winning label's probability.
      confidence: {
        assessment: (answers.assessment as { confidence: number }).confidence,
        verdict: (answers.verdict as { confidence: number }).confidence,
      },
    };
  });

  // The row's model is the one the server reported, not the label this script
  // was invoked with — the requested string is never evidence of what ran. A
  // run served by more than one version is recorded as such rather than
  // averaged under one name.
  const servedModels = [...new Set(rows.map((row) => row.served.model))].sort();
  const report = {
    check: 'test-honesty',
    provider: 'typesafe',
    model: servedModels.join('+'),
    requestedModel: model,
    promptVersion: PROMPT_VERSION,
    // No `qualified` field: ACA-0080 — this measurement never qualifies a route.
    note: 'classification-axis measurement only; every level run, no short-circuit',
    fixtures: rows,
  };

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'test-honesty.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

  const hits = rows.filter((r) => r.status === 'ok').length;
  console.log(`${hits}/${rows.length} fixtures matched on every asked axis`);
  console.log(`wrote ${path} — score it with: node scripts/classification-score.ts ${outDir}`);
}

if (process.argv[1]?.endsWith('jev-classify.ts')) {
  main().catch((err: unknown) => {
    console.error(`jev-classify: ${(err as Error).message}`);
    process.exit(1);
  });
}
