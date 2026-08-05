// Calibration self-test for doc-drift (ACA-0012 exam shape, forked):
// fixtures run through the REAL extraction, evidence assembly, judging, and
// verdict mapping — the manifest supplies the changed-referent bundle a git
// change index would (the index itself is unit-tested; fixtures live outside
// any repo). Always live, never cached. A fixture whose doc yields no
// candidate reference is an integrity error before any judge call — the
// mechanical path is broken, not the judge. If an assertion breaks, the
// prompt is wrong, not the fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../core/config.ts';
import type { JudgeClient } from '../../core/judge-client.ts';
import type { SelfTestResult } from '../registry.ts';
import {
  achievedLevel,
  matchExpectation,
  qualifies,
  suiteIdentity,
  validateManifest,
  type CalibrationFixture,
  type Expectation,
  type LevelStatus,
} from './calibration.ts';
import type { ChangeIndex, Referent } from './change-index.ts';
import { buildEvidence, type EvidenceBundle } from './evidence.ts';
import {
  EXTRACTION_VERSION,
  judgeOutcome,
  MAX_TOKENS,
  PROMPT_VERSION,
  rubricText,
  systemPrompt,
  userPrompt,
  VERDICT_SCHEMA,
  type DocDriftVerdict,
} from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { extractReferences } from './references.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url);

interface FixtureReport {
  name: string;
  level: string;
  status: 'ok' | 'miss' | 'skipped';
  expected: Expectation;
  actual?: { assessment?: string; verdict: string; criteria: string[]; note?: string };
}

/** The machine-readable qualification record (ACA-0012). Carries no fixture
 * contents and no prompts — identity, grades, and per-fixture outcomes only. */
export interface SelfTestReport {
  promptVersion: string;
  extractionVersion: string;
  fixtureSuite: string;
  requiredLevel: string;
  achievedLevel: string | null;
  qualified: boolean;
  levels: { id: string; status: LevelStatus }[];
  fixtures: FixtureReport[];
}

export interface GradedSelfTestResult extends SelfTestResult {
  report: SelfTestReport;
}

/** The manifest's referent bundle, shaped as the change index would shape
 * it — same statuses, same head/base semantics. */
function indexOf(fixture: CalibrationFixture, contentOf: (file: string) => string | undefined): ChangeIndex {
  const index: ChangeIndex = new Map();
  for (const referent of fixture.referents) {
    const entry: Referent = { path: referent.path, status: referent.status };
    if (referent.renamedTo !== undefined) entry.renamedTo = referent.renamedTo;
    if (referent.head !== undefined) entry.head = contentOf(referent.head.content)!;
    if (referent.base !== undefined) entry.base = contentOf(referent.base.content)!;
    index.set(referent.path, entry);
  }
  return index;
}

function describe(verdict: DocDriftVerdict): string {
  const criteria = (verdict.findings ?? []).map((finding) => finding.criterion);
  const parts = [criteria.length ? `[${criteria.join(', ')}]` : '', verdict.note ? `(${verdict.note})` : ''].filter(Boolean);
  return [`${verdict.assessment ?? 'degraded'}/${verdict.verdict}`, ...parts].join(' ');
}

function describeExpectation(expect: Expectation): string {
  return [
    `${expect.assessmentAnyOf.join('|')}/${expect.verdictAnyOf.join('|')}`,
    expect.criteriaAnyOf ? `[any of: ${expect.criteriaAnyOf.join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function selfTest(client: JudgeClient): Promise<GradedSelfTestResult> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);

  const manifestText = readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new ConfigError(`self-test manifest: invalid JSON — ${(err as Error).message}`);
  }
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
  const manifest = validateManifest(raw, contentOf);

  // The extraction gate and the suite identity both come before any judge
  // call: a fixture that no longer yields a candidate is a broken exam.
  const prepared = new Map<string, { docContent: string; bundle: EvidenceBundle }>();
  for (const fixture of manifest.fixtures) {
    const docContent = contentOf(fixture.doc.content)!;
    const bundle = buildEvidence(extractReferences(fixture.doc.path, docContent), indexOf(fixture, contentOf));
    if (bundle.references.length === 0) {
      throw new ConfigError(`self-test manifest: fixture "${fixture.name}" extracts no candidate reference — the mechanical prefilter or the fixture is broken`);
    }
    prepared.set(fixture.name, { docContent, bundle });
  }
  const referenced = manifest.fixtures.flatMap((fixture) => [
    contentOf(fixture.doc.content)!,
    ...fixture.referents.flatMap((referent) => [...(referent.head ? [contentOf(referent.head.content)!] : []), ...(referent.base ? [contentOf(referent.base.content)!] : [])]),
  ]);
  const fixtureSuite = suiteIdentity([PROMPT_VERSION, EXTRACTION_VERSION], rubric, manifestText, referenced);

  const levelIds = manifest.levels.map((level) => level.id);
  const levelStatus = new Map<string, LevelStatus>();
  const reports = new Map<string, FixtureReport>();
  const lines: string[] = [`self-test (${PROMPT_VERSION}, suite ${fixtureSuite}) via ${client.provider}/${client.model}`];

  let stopped = false;
  for (const id of levelIds) {
    const fixtures = manifest.fixtures.filter((fixture) => fixture.level === id);
    if (stopped) {
      levelStatus.set(id, 'skipped');
      for (const fixture of fixtures) {
        reports.set(fixture.name, { name: fixture.name, level: id, status: 'skipped', expected: fixture.expect });
        lines.push(`skip [${id}] ${fixture.name}: a lower level missed`);
      }
      continue;
    }
    const verdicts = await mapPool(fixtures, CONCURRENCY, async (fixture) => {
      const { docContent, bundle } = prepared.get(fixture.name)!;
      const result = await client.judge({ system, user: userPrompt(fixture.doc.path, docContent, bundle), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
      return judgeOutcome(fixture.doc.path, bundle, result).verdict;
    });
    let passed = true;
    fixtures.forEach((fixture, index) => {
      const verdict = verdicts[index]!;
      const ok = matchExpectation(fixture.expect, verdict);
      if (!ok) passed = false;
      reports.set(fixture.name, {
        name: fixture.name,
        level: id,
        status: ok ? 'ok' : 'miss',
        expected: fixture.expect,
        actual: {
          ...(verdict.assessment !== undefined ? { assessment: verdict.assessment } : {}),
          verdict: verdict.verdict,
          criteria: (verdict.findings ?? []).map((finding) => finding.criterion),
          ...(verdict.note !== undefined ? { note: verdict.note } : {}),
        },
      });
      lines.push(`${ok ? 'ok' : 'MISS'} [${id}] ${fixture.name}: got ${describe(verdict)}, expected ${describeExpectation(fixture.expect)}`);
    });
    levelStatus.set(id, passed ? 'passed' : 'failed');
    if (!passed) stopped = true;
  }

  const achieved = achievedLevel(levelIds, levelStatus);
  const qualified = qualifies(levelIds, achieved, manifest.requiredLevel);
  lines.push(`qualification: achieved ${achieved ?? 'none'}, required ${manifest.requiredLevel}`);

  return {
    passed: qualified,
    lines,
    report: {
      promptVersion: PROMPT_VERSION,
      extractionVersion: EXTRACTION_VERSION,
      fixtureSuite,
      requiredLevel: manifest.requiredLevel,
      achievedLevel: achieved,
      qualified,
      levels: levelIds.map((id) => ({ id, status: levelStatus.get(id)! })),
      fixtures: manifest.fixtures.map((fixture) => reports.get(fixture.name)!),
    },
  };
}
