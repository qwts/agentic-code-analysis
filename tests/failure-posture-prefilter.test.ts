import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFile, stripInert, type PrefilterHint } from '../src/checks/failure-posture/prefilter.ts';

const hint = (kind: string, source: string, token: string): PrefilterHint => ({ kind, source, token }) as PrefilterHint;

test('pure declarations and arithmetic skip: no external-dependency signals', () => {
  const result = classifyFile('src/math.ts', 'export const add = (a: number, b: number): number => a + b;\nexport const TAU = 6.28;\n');
  assert.equal(result.candidate, false);
  assert.equal(result.reason, 'no external-dependency signals');
  assert.deepEqual(result.hints, []);
});

test('type-only imports of effectful modules do not signal', () => {
  const result = classifyFile('src/types.ts', `import type { Agent } from 'node:https';\nexport type Pool = { agent: Agent };\n`);
  assert.equal(result.candidate, false);
});

test('comment- and string-only mentions do not signal', () => {
  const content = `// later we could fetch(url) here\nconst doc = 'call fetch(COORDINATOR) with new WebSocket semantics';\nexport const note = doc;\n`;
  assert.equal(classifyFile('src/notes.ts', content).candidate, false);
});

test('direct global APIs signal with kind and token', () => {
  const result = classifyFile('src/api.ts', `export async function load(url: string) {\n  const r = await fetch(url);\n  return r.json();\n}\n`);
  assert.equal(result.candidate, true);
  assert.deepEqual(result.hints, [hint('network', 'call', 'fetch')]);
});

test('runtime imports, require, and dynamic import of effectful modules signal by kind', () => {
  const cases: [string, PrefilterHint][] = [
    [`import { request } from 'node:https';\n`, hint('network', 'import', 'node:https')],
    [`import { readFile } from 'node:fs/promises';\n`, hint('storage', 'import', 'node:fs/promises')],
    [`const pg = require('pg');\n`, hint('storage', 'import', 'pg')],
    [`const kafka = await import('kafkajs');\n`, hint('queue', 'import', 'kafkajs')],
    [`import { execFile } from 'node:child_process';\n`, hint('subprocess', 'import', 'node:child_process')],
  ];
  for (const [content, expected] of cases) {
    const result = classifyFile('src/x.ts', content);
    assert.equal(result.candidate, true, content);
    assert.deepEqual(result.hints, [expected], content);
  }
});

test('awaited calls on injected boundary-like symbols signal as injected-boundary', () => {
  const content = `export async function save(userRepository: { save(u: unknown): Promise<void> }, u: unknown) {\n  await userRepository.save(u);\n}\n`;
  const result = classifyFile('src/save.ts', content);
  assert.deepEqual(result.hints, [hint('storage', 'injected-boundary', 'userRepository')]);
  const queue = classifyFile('src/q.ts', `export const push = async (jobQueue: { add(j: string): Promise<void> }) => {\n  await jobQueue.add('j');\n};\n`);
  assert.deepEqual(queue.hints, [hint('queue', 'injected-boundary', 'jobQueue')]);
});

test('boundary-suffixed constructors signal; unrelated awaits do not', () => {
  const ctor = classifyFile('src/c.ts', `const c = new BillingClient({ retries: 2 });\nexport default c;\n`);
  assert.deepEqual(ctor.hints, [hint('network', 'injected-boundary', 'new BillingClient')]);
  const unrelated = classifyFile('src/p.ts', `export async function run(promise: Promise<number>) {\n  const helper = { double: async (n: number) => n * 2 };\n  return helper.double(await promise);\n}\n`);
  assert.equal(unrelated.candidate, false);
});

test('duplicate signals deduplicate to one hint', () => {
  const result = classifyFile('src/dup.ts', `await fetch(a);\nawait fetch(b);\nawait fetch(c);\n`);
  assert.equal(result.hints.length, 1);
});

test('non-executable and IaC formats are mechanically out of scope', () => {
  const doc = classifyFile('README.md', `run fetch('https://x') against the pg database\n`);
  assert.equal(doc.candidate, false);
  assert.equal(doc.reason, 'non-executable format');
  const iac = classifyFile('infra/main.tf', 'resource "aws_s3_bucket" "b" {}\n');
  assert.equal(iac.candidate, false);
  assert.match(iac.reason, /IaC/);
  for (const path of ['data.json', 'config.yaml', 'package-lock.lock', 'diagram.svg']) {
    assert.equal(classifyFile(path, 'fetch(').candidate, false, path);
  }
});

test('unknown source languages are candidates, never silently skipped', () => {
  const py = classifyFile('scripts/sync.py', 'import requests\nrequests.get(url)\n');
  assert.equal(py.candidate, true);
  assert.match(py.reason, /unsupported syntax/);
  assert.deepEqual(py.hints, []);
  assert.equal(classifyFile('bin/deploy', '#!/bin/sh\ncurl -s https://x\n').candidate, true);
});

test('stripInert removes comments and string bodies but keeps code', () => {
  const stripped = stripInert(`// fetch(one)\n/* fetch(two) */\nconst s = "fetch(three)";\nconst t = \`fetch(\${four})\`;\nawait fetch(url);\n`);
  assert.ok(!stripped.includes('one') && !stripped.includes('two') && !stripped.includes('three') && !stripped.includes('four'));
  assert.match(stripped, /await fetch\(url\)/);
});
