// Publication boundary: emit the authored TypeScript as JavaScript, then put
// every runtime-read non-code asset beside the emitted module that reads it.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceChecks = join(root, 'src', 'checks');
const outputChecks = join(root, 'dist', 'checks');
const output = join(root, 'dist');
const typeScriptCli = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, [typeScriptCli, '-p', join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
});

for (const entry of readdirSync(sourceChecks, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join(sourceChecks, entry.name);
  const destination = join(outputChecks, entry.name);
  const fixtures = join(source, 'fixtures');
  if (existsSync(fixtures)) {
    mkdirSync(destination, { recursive: true });
    cpSync(fixtures, join(destination, 'fixtures'), { recursive: true });
  }
  const rubric = join(source, 'rubric.md');
  if (existsSync(rubric)) {
    mkdirSync(dirname(join(destination, 'rubric.md')), { recursive: true });
    cpSync(rubric, join(destination, 'rubric.md'));
  }
}
