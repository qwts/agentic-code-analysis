import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../src/core/config.ts';
import { achievedLevel, matchExpectation, qualifies, validateManifest } from '../src/checks/doc-drift/calibration.ts';
import { selfTest, type GradedSelfTestResult } from '../src/checks/doc-drift/self-test.ts';
import type { DocDriftVerdict } from '../src/checks/doc-drift/judge-io.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

const FIXTURES_DIR = new URL('../src/checks/doc-drift/fixtures/', import.meta.url);
const manifestRaw = () => JSON.parse(readFileSync(fileURLToPath(new URL('manifest.json', FIXTURES_DIR)), 'utf8'));
const contentOf = (file: string): string | undefined => {
  try {
    return readFileSync(fileURLToPath(new URL(file, FIXTURES_DIR)), 'utf8');
  } catch {
    return undefined;
  }
};

function scriptedClient(judge: (request: JudgeRequest) => JudgeResult): JudgeClient {
  return { provider: 'stub', model: 'stub-model', judge: async (request) => judge(request) };
}

test('the shipped manifest validates: checksums, levels, statuses, expectations', () => {
  const manifest = validateManifest(manifestRaw(), contentOf);
  assert.equal(manifest.requiredLevel, 'discrimination');
  assert.deepEqual(manifest.levels.map((l) => l.id), ['foundation', 'discrimination']);
  assert.equal(manifest.fixtures.length, 7);
});

test('a tampered checksum or an escaping file name is an integrity error, not a judge miss', () => {
  const tampered = manifestRaw();
  tampered.fixtures[0].doc.sha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(tampered, contentOf), /fails its checksum/);
  const escaping = manifestRaw();
  escaping.fixtures[0].doc.content = '../secret.md';
  assert.throws(() => validateManifest(escaping, contentOf), ConfigError);
  const headless = manifestRaw();
  delete headless.fixtures[0].referents[0].head;
  assert.throws(() => validateManifest(headless, contentOf), /needs head content/);
});

test('matchExpectation demands an in-set assessment and verdict, and a substantiated criterion when expected', () => {
  const expect = { assessmentAnyOf: ['drifted'], verdictAnyOf: ['fail' as const], criteriaAnyOf: ['claim-contradicts-code'] };
  const base: DocDriftVerdict = {
    file: 'docs/x.md',
    verdict: 'fail',
    cached: false,
    violations: [],
    assessment: 'drifted',
    scanMode: 'explicit-markdown-references',
    references: [],
    referents: [],
    findings: [{ criterion: 'claim-contradicts-code', claim: 'says 3', reference_ids: ['r1'], evidence: 'code says 5', suggestion: 'fix' }],
  };
  assert.ok(matchExpectation(expect, base));
  assert.ok(!matchExpectation(expect, { ...base, assessment: 'incomplete' }));
  assert.ok(!matchExpectation(expect, { ...base, findings: [{ ...base.findings![0]!, criterion: 'referent-gone' }] }));
  assert.ok(!matchExpectation(expect, { ...base, findings: [{ ...base.findings![0]!, evidence: ' ' }] }), 'a bare label is not a detection');
});

test('grading is contiguous with no partial credit', () => {
  const levels = ['foundation', 'discrimination'];
  assert.equal(achievedLevel(levels, new Map([['foundation', 'passed'], ['discrimination', 'failed']])), 'foundation');
  assert.equal(achievedLevel(levels, new Map([['foundation', 'failed'], ['discrimination', 'passed']])), null);
  assert.ok(qualifies(levels, 'discrimination', 'discrimination'));
  assert.ok(!qualifies(levels, 'foundation', 'discrimination'));
});

/** Answer fixtures by recognizing their payload, as an oracle judge would. */
function oracle(request: JudgeRequest): JudgeResult {
  const user = request.user;
  const finding = (criterion: string, claim: string, id: string) => ({
    criterion,
    claim,
    reference_ids: [id],
    evidence: 'quoted from the supplied referent contents',
    suggestion: 'update the documentation',
  });
  const firstId = (needle: string): string => {
    const line = user.split('\n').find((l) => l.includes(needle));
    return line?.match(/^(r\d+):/)?.[1] ?? 'r1';
  };
  if (user.includes('`DEFAULT_RETRIES` is 3')) {
    return { ok: true, verdict: { assessment: 'drifted', findings: [finding('claim-contradicts-code', 'DEFAULT_RETRIES is 3', firstId('DEFAULT_RETRIES'))], reasoning_summary: 'contradicts' } };
  }
  if (user.includes('Document: docs/jitter.md')) {
    return { ok: true, verdict: { assessment: 'drifted', findings: [finding('referent-gone', 'jitter.ts holds the randomization', firstId('jitter'))], reasoning_summary: 'deleted' } };
  }
  if (user.includes('Document: docs/cli.md')) {
    return { ok: true, verdict: { assessment: 'drifted', findings: [finding('example-no-longer-runs', 'retry-cli --jitter full', firstId('--jitter'))], reasoning_summary: 'flag removed' } };
  }
  if (user.includes('Document: docs/retry-tuning.md')) {
    return { ok: true, verdict: { assessment: 'incomplete', findings: [finding('incomplete-new-behavior', 'delay doubling narrative omits the cap', firstId('DEFAULT_RETRIES'))], reasoning_summary: 'silent on maxDelayMs' } };
  }
  return { ok: true, verdict: { assessment: 'aligned', findings: [], reasoning_summary: 'holds' } };
}

test('the graded self-test qualifies with an oracle judge and reports machine-readable evidence', async () => {
  const result = (await selfTest(scriptedClient(oracle))) as GradedSelfTestResult;
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'discrimination');
  assert.match(result.report.fixtureSuite, /^sha256:/);
  assert.ok(result.report.fixtures.every((f) => f.status === 'ok'));
});

test('an always-pass judge misses the contradictory fixture and does not qualify (negative control)', async () => {
  const alwaysPass = scriptedClient(() => ({ ok: true, verdict: { assessment: 'aligned', findings: [], reasoning_summary: 'all good' } }));
  const result = (await selfTest(alwaysPass)) as GradedSelfTestResult;
  assert.equal(result.passed, false);
  assert.equal(result.report.achievedLevel, null);
  const contradicted = result.report.fixtures.find((f) => f.name === 'claim-contradicts-default')!;
  assert.equal(contradicted.status, 'miss');
  assert.ok(result.report.fixtures.some((f) => f.status === 'skipped'), 'higher levels stop after a failed level');
});
