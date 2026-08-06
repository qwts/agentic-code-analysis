// Hermetic release-candidate check: assert the complete npm surface, install
// the exact tarball in a clean consumer, and invoke the linked executable.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
  size: number;
  unpackedSize: number;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'aca-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: process.env['npm_config_cache'] ?? join(scratch, 'npm-cache'),
      npm_config_fund: 'false',
    },
  });
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

function packagePath(path: string): string {
  return relative(root, path).split(sep).join('/');
}

try {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.equal(metadata.bin?.['aca'], 'dist/cli.js');
  assert.deepEqual(metadata.files, ['dist/', 'docs/standards/']);
  assert.equal(metadata.scripts?.['prepack'], 'npm run build:package');
  run(process.execPath, [join(root, 'scripts', 'build-package.ts')]);
  const raw = run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]);
  const packed = (JSON.parse(raw) as PackResult[])[0];
  assert.ok(packed, 'npm pack returned no artifact');
  const paths = new Set(packed.files.map((file) => file.path));

  for (const path of paths) {
    assert.ok(
      path === 'package.json' || path === 'README.md' || path === 'LICENSE' || path.startsWith('dist/') || path.startsWith('docs/standards/'),
      `unexpected published file: ${path}`,
    );
  }

  const emitted = filesUnder(join(root, 'src'))
    .filter((path) => path.endsWith('.ts') && !path.split(sep).includes('fixtures'))
    .map((path) => packagePath(path).replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
  const assets = filesUnder(join(root, 'src'))
    .filter((path) => !path.endsWith('.ts') || path.split(sep).includes('fixtures'))
    .map((path) => packagePath(path).replace(/^src\//, 'dist/'));
  const standards = filesUnder(join(root, 'docs', 'standards')).map(packagePath);
  const requiredFiles = ['dist/cli.js', ...emitted, ...assets, ...standards];
  for (const required of requiredFiles) {
    assert.ok(paths.has(required), `required runtime file missing from package: ${required}`);
  }
  const expected = new Set(['package.json', 'README.md', 'LICENSE', ...requiredFiles]);
  assert.deepEqual([...paths].sort(), [...expected].sort(), 'published file list differs from the exact runtime allowlist');

  const banned = [
    /\/Users\/[^/\s]+/,
    /~\/Library\//,
    /Canonical source:/,
    /github\.com\/[^\s]+\/pull\//,
    /Stated by [A-Z][a-z]+/,
  ];
  for (const path of [...filesUnder(join(root, 'dist')), ...filesUnder(join(root, 'docs', 'standards')), join(root, 'README.md')]) {
    const content = readFileSync(path, 'utf8');
    for (const pattern of banned) assert.doesNotMatch(content, pattern, `private identifier in published file ${packagePath(path)}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'src', 'checks', 'context-footprint', 'fixtures', 'manifest.json'), 'utf8')) as {
    fixtures: { level: string; source?: Record<string, string> }[];
  };
  const fieldSource = manifest.fixtures.find((fixture) => fixture.level === 'field')?.source;
  assert.ok(fieldSource, 'field fixture provenance is missing');
  assert.deepEqual(Object.keys(fieldSource).sort(), ['kind', 'license', 'permission']);
  assert.equal(fieldSource['kind'], 'author-supplied');
  assert.match(fieldSource['license']!, /Apache-2\.0 for this calibration fixture only/);
  assert.match(fieldSource['permission']!, /copyright holder licenses this fixture excerpt/);

  const archive = join(scratch, basename(packed.filename));
  const consumer = join(scratch, 'consumer');
  run(npm, ['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const installed = join(consumer, 'node_modules', 'agentic-code-analysis');
  await import(pathToFileURL(join(installed, 'dist', 'core', 'adapters', 'anthropic.js')).href);
  await import(pathToFileURL(join(installed, 'dist', 'core', 'adapters', 'openai.js')).href);
  const contextJudge = (await import(pathToFileURL(join(installed, 'dist', 'checks', 'context-footprint', 'judge-io.js')).href)) as {
    ruleText(): string;
  };
  assert.match(contextJudge.ruleText(), /smallest practical context footprint/);
  const executable = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'aca.cmd' : 'aca');
  const help = run(executable, ['--help'], consumer);
  assert.match(help, /^usage: aca <check>/);
  assert.match(help, /skill-information-architecture/);
  assert.equal(run(executable, ['--version'], consumer).trim(), '0.1.0');
  process.stdout.write(`package smoke passed: ${paths.size} files, ${packed.size} packed bytes, ${packed.unpackedSize} unpacked bytes\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
