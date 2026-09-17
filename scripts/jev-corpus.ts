// Spike (ACA-0080): what fraction of REAL test files would a System One
// screen settle without calling the qualified judge?
//
// The calibration fixtures cannot answer this. They are adversarial by
// construction — dense with planted dishonesty — so their pass rate says
// nothing about a working repository, and the pass rate is the number the
// whole cascade's economics turn on. The error this design cannot recover
// from is a confident pass on a file that should fail, and that risk lives in
// ordinary clean-looking code rather than in the fixtures.
//
// Uses the check's production selection and evidence path — both scope
// stages (the core include/exclude pass, then the check-local test-file
// pass) and buildEvidence with the same companion-context bounds — so a file
// is presented to Jev exactly as it would be to the judge. No judge is called
// and no verdict is published: this counts what a screen would absorb.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { ASSESSMENTS, rubricText, systemPrompt, userPrompt } from '../src/checks/test-honesty/judge-io.ts';
import { CONCURRENCY, mapPool } from '../src/checks/test-honesty/pool.ts';
import { scopeTestFiles, testFileGlobs } from '../src/checks/test-honesty/scope.ts';
import { buildEvidence } from '../src/checks/test-honesty/unit-context.ts';
import { filterScope } from '../src/core/change-scope.ts';
import { loadConfig, type AcaConfig } from '../src/core/config.ts';

export interface ScreenRow {
  file: string;
  verdict: string;
  confidence: number;
}

/** The corpus a real run would judge: both scope stages, in the order
 * production applies them — the core include/exclude pass, then the
 * check-local test-file pass. Running only the second admits files the
 * consuming repo excluded, and a repo that excludes its own planted
 * calibration fixtures would have them measured as real code. */
export function corpusFiles(
  tracked: string[],
  config: Pick<AcaConfig, 'include' | 'exclude'>,
  globs: readonly string[],
): string[] {
  return scopeTestFiles(filterScope(tracked, config), globs);
}

/** Files a screen would settle without calling the judge: a pass it is
 * confident enough about. Anything else — a fail, a warn, or a pass below the
 * threshold — escalates, so only `pass` is eligible however high its
 * confidence. A fail the route is certain of still needs the judge's prose,
 * which is the whole reason it cannot be admitted as one (ACA-0080). */
export function settledAt(rows: readonly ScreenRow[], threshold: number): ScreenRow[] {
  return rows.filter((row) => row.verdict === 'pass' && row.confidence >= threshold);
}

function resolveApiKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(homedir(), '.config', 'typesafe', 'api-key');
  const fromFile = readFileSync(path, 'utf8').trim();
  if (!fromFile) throw new Error(`empty key at ${path}`);
  return fromFile;
}

/** Candidate test files, discovered with git so ignored and vendored paths
 * stay out without reimplementing the corpus rules. */
function trackedFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

async function main(): Promise<void> {
  process.env.TYPESAFE_API_KEY = resolveApiKey();
  const repoRoot = process.argv[2];
  const limit = Number(process.argv[3] ?? '40');
  if (!repoRoot) throw new Error('usage: node scripts/jev-corpus.ts <repo-root> [limit]');

  // Both scope stages, in the order a real run applies them: the core
  // include/exclude pass first, then the check-local test-file pass. Running
  // only the second admitted this repo's own planted calibration fixtures —
  // excluded by aca.config.json — into a corpus reported as real code, which
  // is the contamination PR #94's review caught.
  const config = loadConfig(repoRoot);
  const globs = testFileGlobs(repoRoot);
  const files = corpusFiles(trackedFiles(repoRoot), config, globs).slice(0, limit);
  if (files.length === 0) throw new Error(`no test files in ${repoRoot}`);

  const system = systemPrompt(rubricText());
  const client = new TypeSafeClient();
  const questions = {
    assessment: choice(
      'Judged against the rubric, is this test file honest?',
      Object.fromEntries(ASSESSMENTS.map((a) => [a, null])) as Record<(typeof ASSESSMENTS)[number], null>,
    ),
    verdict: choice('What verdict should this file receive?', { pass: null, warn: null, fail: null }),
  };

  let inputTokens = 0;
  // Provenance, on the same footing as the fixture script: the aggregate is
  // only tied to a candidate if the run records which model served it, and a
  // mixed-version run must read as mixed rather than as either version.
  const servedModels = new Set<string>();
  const unscreenable: { file: string; note: string }[] = [];
  const settled = await mapPool(files, CONCURRENCY, async (file): Promise<ScreenRow | undefined> => {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    const evidence = buildEvidence(repoRoot, file, content, globs);
    try {
      const { answers, model: served, usage } = await client.systemOne({
        state: { rubric: system, evidence: userPrompt(evidence) },
        questions,
      });
      servedModels.add(served);
      inputTokens += usage.input_tokens;
      return { file, verdict: answers.verdict.choice, confidence: answers.verdict.confidence };
    } catch (err) {
      // A file the route cannot read is not a pass and not a fail — it is
      // absent evidence. Recorded and excluded from every ratio rather than
      // scored, and it would escalate to the judge in a real cascade. One
      // unreadable file never suppresses the rest of the sweep.
      unscreenable.push({ file, note: (err as Error).message.slice(0, 80) });
      return undefined;
    }
  });
  const rows: ScreenRow[] = settled.filter((row) => row !== undefined);
  if (rows.length === 0) throw new Error(`no file in ${repoRoot} could be screened`);

  const pass = rows.filter((r) => r.verdict === 'pass');
  const at = (t: number): number => settledAt(rows, t).length;
  const pct = (n: number): string => `${((n / rows.length) * 100).toFixed(0)}%`;

  console.log(`${repoRoot}  —  ${rows.length} test files screened of ${files.length}`);
  console.log(`  served by: ${[...servedModels].sort().join(', ')}`);
  if (unscreenable.length > 0) {
    console.log(`  unscreenable: ${unscreenable.length} (excluded from every ratio below, would escalate)`);
    for (const u of unscreenable.slice(0, 3)) console.log(`    ${u.file} — ${u.note}`);
  }
  console.log(`  verdicts: pass ${pass.length}, warn ${rows.filter((r) => r.verdict === 'warn').length}, fail ${rows.filter((r) => r.verdict === 'fail').length}`);
  console.log('  settled by the screen (confident pass), by threshold:');
  for (const t of [0.6, 0.7, 0.8, 0.9]) console.log(`    >=${t.toFixed(2)}  ${at(t)}/${rows.length}  (${pct(at(t))} of judge calls avoided)`);
  console.log(`  cost: ${inputTokens.toLocaleString()} input tokens = $${((inputTokens / 1e6) * 0.045).toFixed(5)}`);

  // Named individually rather than counted: a non-pass is a candidate true
  // positive, and the false-negative question cannot be worked without
  // knowing which files to read.
  const flagged = rows.filter((r) => r.verdict !== 'pass');
  if (flagged.length > 0) {
    console.log('  flagged (candidate true positives — read these):');
    for (const r of flagged) console.log(`    ${r.verdict.toUpperCase()} conf=${r.confidence.toFixed(2)}  ${r.file}`);
  }

  const low = settledAt(rows, 0).filter((r) => r.confidence < 0.7).slice(0, 5);
  if (low.length > 0) {
    console.log('  low-confidence passes (these would still reach the judge):');
    for (const r of low) console.log(`    ${r.confidence.toFixed(2)}  ${r.file}`);
  }
}

if (process.argv[1]?.endsWith('jev-corpus.ts')) {
  main().catch((err: unknown) => {
    console.error(`jev-corpus: ${(err as Error).message}`);
    process.exit(1);
  });
}
