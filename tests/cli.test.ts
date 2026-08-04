import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, run } from '../src/cli.ts';
import type { Check, CheckLoader, FileVerdict } from '../src/checks/registry.ts';
import { MissingCredentialsError, type JudgeClient } from '../src/core/judge-client.ts';

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
  assert.equal(await run(['fake', 'a.ts', '--enforce'], noCreds), EXIT.noCredentials);
});

test('--json emits cache visibility per verdict', async () => {
  const out: string[] = [];
  await run(['fake', 'a.ts', '--json'], deps([PASS], out));
  const parsed = JSON.parse(out.at(-1)!);
  assert.equal(parsed.verdicts[0].cached, true);
  assert.equal(parsed.model, 'stub-model');
});
