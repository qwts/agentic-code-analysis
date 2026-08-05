import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { check } from '../src/checks/test-honesty/index.ts';
import { checks } from '../src/checks/registry.ts';
import { EXIT, run } from '../src/cli.ts';
import { ConfigError } from '../src/core/config.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';

// Route the tier through the env override so the CLI integration test needs
// no tier map; the stub clientFactory ignores the route anyway.
process.env['ACA_PROVIDER'] = 'stub';
process.env['ACA_MODEL'] = 'stub-model';

const HONEST_VERDICT = { assessment: 'honest', findings: [], reasoning_summary: 'discriminating assertions' };

function countingClient(result: (request: JudgeRequest) => JudgeResult | Promise<JudgeResult>): { client: JudgeClient; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    client: {
      provider: 'stub',
      model: 'stub-model',
      judge: async (request) => {
        requests.push(request);
        return result(request);
      },
    },
  };
}

function tempRepo(): { root: string; write: (path: string, content: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'aca-honesty-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (path: string, content: string): void => {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  write('src/adder.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  write('tests/adder.test.ts', `import { add } from '../src/adder.ts';\n\ntest('add sums', () => {\n  assert.equal(add(2, 2), 4);\n});\n`);
  git('add', '.');
  git('commit', '-m', 'base', '--quiet');
  return { root, write };
}

function context(root: string, client: JudgeClient, files: string[]) {
  return { repoRoot: root, baseRef: 'main', files, client, cache: new VerdictCache(join(root, '.cache', 'aca'), check.name) };
}

test('non-test files — changed or explicit — cause zero judge calls and no verdicts', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const verdicts = await check.run(context(root, client, ['src/adder.ts', 'README.md']));
  assert.deepEqual(verdicts, []);
  assert.equal(requests.length, 0);
});

test('a second identical run makes zero judge calls; unit-export changes miss the cache', async () => {
  const { root, write } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const first = await check.run(context(root, client, ['tests/adder.test.ts']));
  assert.equal(requests.length, 1);
  assert.deepEqual(first.map((v) => [v.verdict, v.cached]), [['pass', false]]);

  const second = await check.run(context(root, client, ['tests/adder.test.ts']));
  assert.equal(requests.length, 1, 'cache hit must not call the judge');
  assert.deepEqual(second.map((v) => [v.verdict, v.cached]), [['pass', true]]);

  // The judged test file is unchanged, but its companion context is not:
  // the export surface is a semantic input and must miss.
  write('src/adder.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport const VERSION = 2;\n');
  await check.run(context(root, client, ['tests/adder.test.ts']));
  assert.equal(requests.length, 2, 'changed unit exports must rejudge');
});

test('degraded results are not cached: the next run retries the judge', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: false, note: 'api error: overloaded' }));
  const first = await check.run(context(root, client, ['tests/adder.test.ts']));
  assert.deepEqual(first.map((v) => v.verdict), ['warn']);
  await check.run(context(root, client, ['tests/adder.test.ts']));
  assert.equal(requests.length, 2, 'degraded verdicts must retry, not stick');
});

test('explicit paths are normalized and deduplicated: one judgment, one verdict', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const verdicts = await check.run(context(root, client, ['tests/adder.test.ts', './tests/adder.test.ts']));
  assert.equal(requests.length, 1, 'duplicate inputs must not bill twice');
  assert.deepEqual(verdicts.map((v) => v.file), ['tests/adder.test.ts']);
});

test('an unreadable in-corpus test degrades to a non-cached warn', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const verdicts = await check.run(context(root, client, ['tests/missing.test.ts']));
  assert.deepEqual(verdicts.map((v) => [v.verdict, v.note]), [['warn', 'unreadable']]);
  assert.equal(requests.length, 0);
});

test('the judge payload carries the rubric, the unit surface, and the test content', async () => {
  const { root } = tempRepo();
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  await check.run(context(root, client, ['tests/adder.test.ts']));
  const request = requests[0]!;
  assert.ok(request.system.includes('# Test-honesty rubric'), 'the rubric ships in the cached system prefix');
  assert.ok(request.user.includes('Unit under test: src/adder.ts'));
  assert.ok(request.user.includes('export function add(a: number, b: number): number {'));
  assert.ok(request.user.includes(`test('add sums'`));
});

test('concurrency stays at 3 and verdicts preserve input order', async () => {
  const { root, write } = tempRepo();
  const files = Array.from({ length: 7 }, (_, i) => `tests/t${i}.test.ts`);
  for (const file of files) write(file, `test('${file}', () => {});\n`);
  let inFlight = 0;
  let peak = 0;
  const { client } = countingClient(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(5);
    inFlight -= 1;
    return { ok: true, verdict: HONEST_VERDICT };
  });
  const verdicts = await check.run(context(root, client, files));
  assert.ok(peak <= 3, `concurrency ceiling exceeded: ${peak}`);
  assert.ok(peak > 1, 'workers must actually run concurrently');
  assert.deepEqual(verdicts.map((v) => v.file), files, 'output order is input order');
});

test('a configured corpus replaces the defaults; an empty one is a ConfigError', async () => {
  const { root, write } = tempRepo();
  write('aca.config.json', JSON.stringify({ checks: { 'test-honesty': { testFiles: ['checks/**/*.check.ts'] } } }));
  write('checks/adder.check.ts', `test('configured corpus', () => {});\n`);
  const { client, requests } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const verdicts = await check.run(context(root, client, ['tests/adder.test.ts', 'checks/adder.check.ts']));
  assert.deepEqual(verdicts.map((v) => v.file), ['checks/adder.check.ts']);
  assert.equal(requests.length, 1);

  write('aca.config.json', JSON.stringify({ checks: { 'test-honesty': { testFiles: [] } } }));
  await assert.rejects(check.run(context(root, client, ['tests/adder.test.ts'])), ConfigError);
});

test('registry and CLI integration: --json exposes the auditable context fields', async () => {
  const loaded = await checks.get('test-honesty')!();
  assert.equal(loaded.name, 'test-honesty');
  assert.equal(loaded.tier, 'T1');

  const { root } = tempRepo();
  const { client } = countingClient(() => ({ ok: true, verdict: HONEST_VERDICT }));
  const out: string[] = [];
  const code = await run(['test-honesty', 'tests/adder.test.ts', '--json'], {
    clientFactory: async () => client,
    cwd: root,
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
  });
  assert.equal(code, EXIT.ok);
  const parsed = JSON.parse(out.at(-1)!);
  assert.equal(parsed.check, 'test-honesty');
  assert.deepEqual(parsed.verdicts[0].context, { mode: 'unit-exports', sources: ['src/adder.ts'] });
  assert.equal(parsed.verdicts[0].cached, false);
});

test('self-test: fixtures judged as expected pass; hollow or lazy judges fail', async () => {
  const byFixture = (request: JudgeRequest): JudgeResult => {
    const finding = (test: string, criterion: string) => ({
      ok: true as const,
      verdict: { assessment: 'dishonest', findings: [{ test, criterion, evidence: 'quoted oracle', meaningful_assertion: 'what a real assertion would establish' }], reasoning_summary: 'cannot fail' },
    });
    const { user } = request;
    if (user.includes('invoice-service')) return finding('fetchInvoiceTotal returns the gateway total', 'asserts-own-mock');
    if (user.includes('config-io')) return finding('serializeConfig produces the expected wire form', 'tautology');
    if (user.includes('parseManifest')) return finding('parseManifest extracts the dependency list', 'no-meaningful-assertion');
    if (user.includes('renderDashboard')) return finding('renderDashboard matches snapshot', 'unreviewable-snapshot');
    return { ok: true, verdict: HONEST_VERDICT };
  };
  const good = await check.selfTest!({ provider: 'stub', model: 'm', judge: async (r) => byFixture(r) });
  assert.equal(good.passed, true, good.lines.join('\n'));
  assert.equal(good.lines.filter((line) => line.startsWith('ok ')).length, 8);

  const alwaysHonest = await check.selfTest!({ provider: 'stub', model: 'm', judge: async () => ({ ok: true, verdict: HONEST_VERDICT }) });
  assert.equal(alwaysHonest.passed, false, 'a judge that always passes is the negative control');
  assert.ok(alwaysHonest.lines.some((line) => line.startsWith('MISS asserts-own-mock')));
  assert.ok(alwaysHonest.lines.some((line) => line.startsWith('MISS tautology')));

  // A fail without meaningful-assertion text is a miss: every finding must
  // state what a discriminating assertion would establish.
  const noSuggestion = await check.selfTest!({
    provider: 'stub',
    model: 'm',
    judge: async (r) => {
      const result = byFixture(r);
      if (result.ok && r.user.includes('invoice-service')) {
        const verdict = result.verdict as { findings: { meaningful_assertion: string }[] };
        verdict.findings[0]!.meaningful_assertion = '';
      }
      return result;
    },
  });
  assert.equal(noSuggestion.passed, false);
  assert.ok(noSuggestion.lines.some((line) => line.startsWith('MISS asserts-own-mock')));
});
