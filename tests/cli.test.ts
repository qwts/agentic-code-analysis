import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.ts';
import type { Check, CheckLoader, FileVerdict } from '../src/checks/registry.ts';
import { JudgeUnavailableError, MissingCredentialsError, type JudgeClient } from '../src/core/judge-client.ts';

// Route the tier through the env override so no aca.config.json is needed;
// the stub clientFactory ignores the route anyway.
process.env['ACA_PROVIDER'] = 'stub';
process.env['ACA_MODEL'] = 'stub-model';

const CLIENT: JudgeClient = { provider: 'stub', model: 'stub-model', judge: async () => ({ ok: false, note: 'unused' }) };

function fakeRegistry(verdicts: FileVerdict[]): ReadonlyMap<string, CheckLoader> {
  const check: Check = { name: 'fake', tier: 'T1', run: async () => verdicts };
  return new Map([['fake', async () => check]]);
}

function deps(verdicts: FileVerdict[], out: string[] = []) {
  return {
    registry: fakeRegistry(verdicts),
    clientFactory: async () => CLIENT,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => out.push(line),
  };
}

const FAIL: FileVerdict = { file: 'a.ts', verdict: 'fail', cached: false, violations: [] };
const PASS: FileVerdict = { file: 'a.ts', verdict: 'pass', cached: true, violations: [] };

test('--help exits 0; missing and unknown checks exit 2', async () => {
  assert.equal(await run(['--help'], deps([])), EXIT.ok);
  assert.equal(await run([], deps([])), EXIT.usage);
  assert.equal(await run(['nonexistent'], deps([])), EXIT.usage);
});

test('usage lists the checks of the injected registry, not the built-in one', async () => {
  const out: string[] = [];
  await run(['--help'], deps([], out));
  assert.match(out[0]!, /checks: fake/);
});

test('advisory mode always exits 0, even on fail verdicts', async () => {
  assert.equal(await run(['fake', 'a.ts'], deps([FAIL])), EXIT.ok);
});

test('--enforce exits 1 on fail, 0 on pass/warn', async () => {
  assert.equal(await run(['fake', 'a.ts', '--enforce'], deps([FAIL])), EXIT.fail);
  assert.equal(await run(['fake', 'a.ts', '--enforce'], deps([PASS])), EXIT.ok);
  assert.equal(await run(['fake', 'a.ts', '--enforce'], deps([{ ...PASS, verdict: 'warn' }])), EXIT.ok);
});

test('missing credentials: one line, exit 0 advisory / 78 enforce', async () => {
  const out: string[] = [];
  const noCreds = {
    ...deps([], out),
    clientFactory: async () => {
      throw new MissingCredentialsError('anthropic');
    },
  };
  assert.equal(await run(['fake', 'a.ts'], noCreds), EXIT.ok);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /no anthropic credentials resolve/);
  assert.equal(await run(['fake', 'a.ts', '--enforce'], noCreds), EXIT.gateDown);
});

test('gate down at judge time: one line, no per-file warns, exit 0 advisory / 78 enforce and self-test', async () => {
  // Quota/auth exhaustion mid-run (issue #11) must never surface as
  // judgments: the run stops with the outage named, not per-file warns.
  const out: string[] = [];
  const unavailable = async (): Promise<never> => {
    throw new JudgeUnavailableError('anthropic', '402 credit depleted');
  };
  const check: Check = { name: 'fake', tier: 'T1', run: unavailable, selfTest: unavailable };
  const gateDown = { ...deps([], out), registry: new Map([['fake', async () => check]]) };
  assert.equal(await run(['fake', 'a.ts'], gateDown), EXIT.ok);
  assert.equal(out.length, 1, 'exactly the gate-down notice, no verdict lines');
  assert.match(out[0]!, /fake: gate down — anthropic judge unavailable — 402 credit depleted/);
  assert.equal(await run(['fake', 'a.ts', '--enforce'], gateDown), EXIT.gateDown);
  assert.equal(await run(['fake', '--self-test'], gateDown), EXIT.gateDown);
});

test('--self-test: exit 0 on pass, 1 on miss, 2 when the check has none', async () => {
  const out: string[] = [];
  const withSelfTest = (passed: boolean) => {
    const base = deps([], out);
    const check: Check = {
      name: 'fake',
      tier: 'T1',
      run: async () => [],
      selfTest: async () => ({ passed, lines: ['fixture line'] }),
    };
    return { ...base, registry: new Map([['fake', async () => check]]) };
  };
  assert.equal(await run(['fake', '--self-test'], withSelfTest(true)), EXIT.ok);
  assert.ok(out.includes('fixture line'));
  assert.equal(await run(['fake', '--self-test'], withSelfTest(false)), EXIT.fail);
  assert.equal(await run(['fake', '--self-test'], deps([])), EXIT.usage);
});

test('--self-test --json emits one object: report spread when present, shared fields otherwise', async () => {
  const out: string[] = [];
  const withResult = (result: object) => {
    const base = deps([], out);
    const check: Check = { name: 'fake', tier: 'T1', run: async () => [], selfTest: async () => result as never };
    return { ...base, registry: new Map([['fake', async () => check]]) };
  };
  const report = { qualified: true, requiredLevel: 'field', achievedLevel: 'field', levels: [] };
  await run(['fake', '--self-test', '--json'], withResult({ passed: true, lines: ['line'], report }));
  const graded = JSON.parse(out.at(-1)!);
  assert.equal(graded.check, 'fake');
  assert.equal(graded.model, 'stub-model');
  assert.equal(graded.qualified, true);
  assert.equal(graded.lines, undefined, 'a structural report replaces the text lines');

  await run(['fake', '--self-test', '--json'], withResult({ passed: true, lines: ['line'] }));
  const fallback = JSON.parse(out.at(-1)!);
  assert.deepEqual(fallback.lines, ['line']);
  assert.equal(fallback.passed, true);

  // The report is duck-typed; it must not be able to restate the run's own
  // identity (Copilot, PR #30).
  await run(['fake', '--self-test', '--json'], withResult({ passed: true, lines: [], report: { ...report, check: 'spoofed', model: 'spoofed' } }));
  const spoofed = JSON.parse(out.at(-1)!);
  assert.equal(spoofed.check, 'fake');
  assert.equal(spoofed.model, 'stub-model');
});

test('--self-test without credentials exits 78 even without --enforce', async () => {
  const noCreds = {
    ...deps([]),
    clientFactory: async () => {
      throw new MissingCredentialsError('anthropic');
    },
  };
  assert.equal(await run(['fake', '--self-test'], noCreds), EXIT.gateDown);
});

test('a residual pass renders as a finding and counts separately; clean passes stay silent', async () => {
  const residualPass: FileVerdict & { residualViolations: unknown } = {
    ...PASS,
    note: 'footprint improved; residual debt',
    residualViolations: [{ criterion: 'duplicated-context', evidence: 'guard enumeration', suggestion: 'move guards to their domains' }],
  };
  const out: string[] = [];
  await run(['fake', 'a.ts'], deps([residualPass, { ...PASS, file: 'b.ts' }], out));
  assert.ok(out.some((l) => l.includes('a.ts: pass (footprint improved; residual debt)')));
  assert.ok(out.some((l) => l.includes('residual duplicated-context: guard enumeration -> move guards to their domains')));
  assert.ok(!out.some((l) => l.startsWith('b.ts:')), 'clean pass stays silent');
  assert.match(out.at(-1)!, /2 file\(s\), 0 fail, 0 warn, 1 residual/);
});

test('a malformed residualViolations value renders as no residuals, never a crash', async () => {
  const malformed = { ...PASS, residualViolations: { bogus: true } } as FileVerdict;
  const out: string[] = [];
  assert.equal(await run(['fake', 'a.ts'], deps([malformed], out)), EXIT.ok);
  assert.match(out.at(-1)!, /1 file\(s\), 0 fail, 0 warn$/);
});

test('--json emits cache visibility per verdict', async () => {
  const out: string[] = [];
  await run(['fake', 'a.ts', '--json'], deps([PASS], out));
  const parsed = JSON.parse(out.at(-1)!);
  assert.equal(parsed.verdicts[0].cached, true);
  assert.equal(parsed.model, 'stub-model');
});

test('the built-in registry lists seam-audit alongside context-footprint in usage', async () => {
  const out: string[] = [];
  await run(['--help'], { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(line) });
  assert.match(out[0]!, /checks: .*context-footprint/);
  assert.match(out[0]!, /checks: .*seam-audit/);
});

test('--json preserves check-specific verdict subtype fields (seam-audit source/footprint)', async () => {
  const out: string[] = [];
  const subtype = {
    ...PASS,
    cached: false,
    assessment: 'new-compliant',
    source: 'mechanical-prefilter',
    testabilityFootprint: [],
  } as FileVerdict;
  await run(['fake', 'a.ts', '--json'], deps([subtype], out));
  const parsed = JSON.parse(out.at(-1)!);
  assert.equal(parsed.verdicts[0].assessment, 'new-compliant');
  assert.equal(parsed.verdicts[0].source, 'mechanical-prefilter');
  assert.deepEqual(parsed.verdicts[0].testabilityFootprint, []);
});
