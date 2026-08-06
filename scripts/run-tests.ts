// Cross-platform test entrypoint: expand the suite in Node so Windows and
// POSIX shells pass the same explicit file list to the built-in test runner.
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = globSync('tests/*.test.ts', { cwd: root }).sort();
tests.push('tools/agent-guard/tests/conformance.test.mjs');
execFileSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
