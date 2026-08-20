import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const calibrate = readFileSync(new URL('../.github/workflows/calibrate.yml', import.meta.url), 'utf8');
const codeql = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');

test('every runner and installer is covered by the runtime contract', () => {
  for (const source of [ci, calibrate, codeql]) {
    for (const match of source.matchAll(/^  ([a-zA-Z0-9_-]+):\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:|\s*$)/gmu)) {
      const name = match[1] ?? 'unknown job';
      const body = match[2] ?? '';
      if (/runs-on:/u.test(body)) assert.match(body, /timeout-minutes:/u, name);
    }
  }
  assert.doesNotMatch(ci + calibrate, /^\s*- run: npm ci$/mu);
  assert.match(ci, /name: Workflow runtime policy/u);
  assert.match(ci, /test "\$WORKFLOW_RUNTIME" = success/u);
});

test('exact-SHA evidence uses the immutable workflow path', () => {
  assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/u);
  assert.doesNotMatch(ci, /\.workflow_runs\[\].*\.name == "CI"/u);
});

test('dispatch-only paid calibration authorizes before checkout or secrets', () => {
  const policy = calibrate.indexOf('uses: qwts/playbook-engineering/.github/actions/ci-policy@');
  assert.ok(policy >= 0);
  assert.ok(policy < calibrate.indexOf('actions/checkout@'));
  assert.ok(policy < calibrate.indexOf('ANTHROPIC_API_KEY'));
  assert.match(calibrate, /authorization-only: 'true'/u);
  assert.match(calibrate, /needs: \[policy, select, qualify\]/u);
  assert.match(calibrate, /if: always\(\) && needs\.policy\.result == 'success'/u);
});
