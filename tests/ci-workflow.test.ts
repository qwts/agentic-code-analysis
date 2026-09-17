import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const calibrate = readFileSync(new URL('../.github/workflows/calibrate.yml', import.meta.url), 'utf8');
const codeql = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');
const agentPr = readFileSync(new URL('../.github/workflows/agent-pr.yml', import.meta.url), 'utf8');

test('every runner and installer is covered by the runtime contract', () => {
  for (const source of [ci, calibrate, codeql, agentPr]) {
    for (const match of source.matchAll(/^  ([a-zA-Z0-9_-]+):\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:|(?![\s\S]))/gmu)) {
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
  const policy = calibrate.indexOf('uses: qwts/qwts-agent-ci/.github/actions/ci-policy@');
  assert.ok(policy >= 0);
  assert.ok(policy < calibrate.indexOf('actions/checkout@'));
  assert.ok(policy < calibrate.indexOf('ANTHROPIC_API_KEY'));
  assert.match(calibrate, /authorization-only: 'true'/u);
  assert.match(calibrate, /needs: \[policy, select, qualify\]/u);
  assert.match(calibrate, /if: always\(\) && needs\.policy\.result == 'success'/u);
});

test('agent PR authorship comes from the App, not the workflow token', () => {
  // A GITHUB_TOKEN-opened PR would be authored by github-actions[bot] and would
  // not trigger pull_request workflows: both defeat the point of the workflow.
  assert.match(agentPr, /uses: actions\/create-github-app-token@[0-9a-f]{40} #/u);
  assert.match(agentPr, /app-id: \$\{\{ vars\.CLAUDE_AGENT_APP_ID \}\}/u);
  assert.match(agentPr, /private-key: \$\{\{ secrets\.CLAUDE_AGENT_PRIVATE_KEY \}\}/u);
  assert.doesNotMatch(agentPr, /secrets\.GITHUB_TOKEN/u);
});

test('agent PR opens as a draft behind a credential guard', () => {
  // ci.yml skips drafts by design, so the session marks the PR ready when it is.
  assert.match(agentPr, /^\s+--draft$/mu);
  // Absent credentials must report a notice, never redden every branch push.
  assert.match(agentPr, /configured=false/u);
  assert.match(agentPr, /if: steps\.credentials\.outputs\.configured == 'true'/u);
});

test('agent PR never expands commit text as a workflow expression', () => {
  const uses = agentPr.match(/github\.event\.head_commit\.message/gu) ?? [];
  assert.equal(uses.length, 1);
  assert.match(agentPr, /^\s+HEAD_MESSAGE: \$\{\{ github\.event\.head_commit\.message \}\}$/mu);
});
