import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SOURCE = join(import.meta.dirname, '..', '.agents', 'skills', 'run-aca', 'scripts', 'run-aca');

interface Fixture {
  root: string;
  checkout: string;
  consumer: string;
  launcher: string;
}

function fixture(inTree = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'aca-run-skill-'));
  const checkout = join(root, 'aca checkout');
  const consumerPath = join(root, 'consumer repo');
  const launcher = inTree
    ? join(checkout, '.agents', 'skills', 'run-aca', 'scripts', 'run-aca')
    : join(root, 'installed skill', 'scripts', 'run-aca');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', 'yaml'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', 'js-tiktoken'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', '@anthropic-ai', 'sdk'), { recursive: true });
  mkdirSync(join(checkout, 'node_modules', 'openai'), { recursive: true });
  mkdirSync(consumerPath, { recursive: true });
  const consumer = realpathSync(consumerPath);
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"name":"agentic-code-analysis"}\n');
  writeFileSync(join(checkout, 'node_modules', 'yaml', 'package.json'), '{}\n');
  writeFileSync(join(checkout, 'node_modules', 'js-tiktoken', 'package.json'), '{}\n');
  writeFileSync(join(checkout, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), '{}\n');
  writeFileSync(join(checkout, 'node_modules', 'openai', 'package.json'), '{}\n');
  writeFileSync(
    join(checkout, 'src', 'cli.ts'),
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n" +
      "process.exit(Number(process.env['ACA_TEST_EXIT'] ?? 0));\n",
  );
  copyFileSync(SOURCE, launcher);
  chmodSync(launcher, 0o755);
  return { root, checkout, consumer, launcher };
}

function run(
  item: Fixture,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  launcher = item.launcher,
) {
  return spawnSync(launcher, args, {
    cwd: item.consumer,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('explicit checkout preserves cwd, literal arguments, and child status', () => {
  const item = fixture();
  try {
    const args = ['context-footprint', 'path with spaces.ts', '$(touch nope)', '--json'];
    const result = run(item, args, { ACA_REPO_ROOT: item.checkout, ACA_TEST_EXIT: '78' });
    assert.equal(result.status, 78);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: item.consumer, args });
    assert.equal(result.stderr, '');
    assert.ok(!readFileSync(item.launcher, 'utf8').includes('eval '));
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('explicit checkout preserves every public child status, including empty arguments', () => {
  const item = fixture();
  try {
    for (const status of [0, 1, 2, 78]) {
      const result = run(item, [], { ACA_REPO_ROOT: item.checkout, ACA_TEST_EXIT: String(status) });
      assert.equal(result.status, status);
      assert.deepEqual(JSON.parse(result.stdout), { cwd: item.consumer, args: [] });
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('in-tree and symlinked launchers resolve the physical checkout', () => {
  const item = fixture(true);
  try {
    const direct = run(item, ['--help'], { ACA_REPO_ROOT: undefined });
    assert.equal(direct.status, 0);
    assert.deepEqual(JSON.parse(direct.stdout), { cwd: item.consumer, args: ['--help'] });

    const link = join(item.root, 'linked-run-aca');
    symlinkSync(item.launcher, link);
    const linked = run(item, ['doc-drift', '--json'], { ACA_REPO_ROOT: undefined }, link);
    assert.equal(linked.status, 0);
    assert.deepEqual(JSON.parse(linked.stdout).args, ['doc-drift', '--json']);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('a genuine aca executable is the final fallback', () => {
  const item = fixture();
  try {
    const bin = join(item.root, 'bin');
    mkdirSync(bin);
    const aca = join(bin, 'aca');
    writeFileSync(aca, '#!/bin/sh\nprintf \'fallback:%s:%s\' "$PWD" "$*"\nexit 1\n');
    chmodSync(aca, 0o755);
    const result = run(item, ['review-readiness', '--json'], {
      ACA_REPO_ROOT: undefined,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `fallback:${item.consumer}:review-readiness --json`);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('an out-of-tree copy never mistakes the consuming repository for ACA', () => {
  const item = fixture();
  try {
    const copied = join(item.consumer, '.agents', 'skills', 'run-aca', 'scripts', 'run-aca');
    mkdirSync(dirname(copied), { recursive: true });
    copyFileSync(SOURCE, copied);
    chmodSync(copied, 0o755);
    mkdirSync(join(item.consumer, 'src'));
    writeFileSync(join(item.consumer, 'package.json'), '{"name":"consumer-repository"}\n');
    writeFileSync(join(item.consumer, 'src', 'cli.ts'), "process.stdout.write('wrong CLI');\n");

    const bin = join(item.root, 'bin');
    mkdirSync(bin);
    const aca = join(bin, 'aca');
    writeFileSync(aca, '#!/bin/sh\nprintf genuine-aca\n');
    chmodSync(aca, 0o755);
    const result = run(item, ['--help'], {
      ACA_REPO_ROOT: undefined,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    }, copied);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'genuine-aca');
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('unresolved checkout reports one actionable error', () => {
  const item = fixture();
  try {
    const bin = join(item.root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const result = run(item, [], {
      ACA_REPO_ROOT: undefined,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'run-aca: ACA checkout not found; set ACA_REPO_ROOT to a full checkout\n');
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('invalid explicit checkout, missing dependencies, and old Node fail without fallback', () => {
  const item = fixture();
  try {
    const invalid = run(item, [], { ACA_REPO_ROOT: join(item.root, 'missing') });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /ACA_REPO_ROOT is not an accessible directory/);

    rmSync(join(item.checkout, 'node_modules', 'yaml'), { recursive: true, force: true });
    const missing = run(item, [], { ACA_REPO_ROOT: item.checkout });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /dependency yaml is missing/);
    assert.match(missing.stderr, /npm clean-install/);

    const bin = join(item.root, 'old-node-bin');
    mkdirSync(bin);
    const node = join(bin, 'node');
    writeFileSync(node, '#!/bin/sh\nprintf \'23\\n\'\n');
    chmodSync(node, 0o755);
    const old = run(item, [], {
      ACA_REPO_ROOT: item.checkout,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.equal(old.status, 2);
    assert.match(old.stderr, /Node >= 24 is required; found Node 23/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('launcher has no network, installer, config-write, or shell-evaluation commands', () => {
  const source = readFileSync(SOURCE, 'utf8');
  for (const forbidden of ['git clone', 'exec npm', 'curl ', 'wget ', 'eval ', 'aca.config.json']) {
    assert.ok(!source.includes(forbidden), `launcher must not contain ${forbidden}`);
  }
  assert.equal(basename(SOURCE), 'run-aca');
});
