// The graded self-test drives fixture trees through the production path with
// a scripted judge: correct replies qualify, one miss fails the level, and
// the report carries identity plus per-fixture outcomes (ACA-0012).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';
import { selfTest } from '../src/checks/agent-rule-conflict/self-test.ts';
import { conflictsFound, noConflict } from './agent-rule-conflict-helpers.ts';

const WITHIN_A = 'Always run the full test suite locally before every commit; a commit without a local test run is rejected.';
const WITHIN_B = 'Never run the full test suite locally — it is far too slow; CI owns all test execution.';
const CROSS_A = 'Install dependencies with npm only; never use pnpm in this repository.';
const CROSS_B = 'This repository uses pnpm exclusively — always install dependencies with pnpm, and treat any npm lockfile as an error.';
const TOOL_A = 'Indent every source file with tabs; spaces for indentation are forbidden in this codebase.';
const TOOL_B = 'Indent every source file with two spaces; tab characters are forbidden in this codebase.';

const pair = (criterion: string, a: [string, string], b: [string, string]) =>
  conflictsFound([
    {
      criterion,
      rule_a: { source_id: a[0], quote: a[1] },
      rule_b: { source_id: b[0], quote: b[1] },
      explanation: 'both cannot be followed together',
      resolution: 'consolidate',
      suggestion: 'keep exactly one of the two rules',
    },
  ]);

function scriptedJudge(crossToolCriterion: string) {
  return {
    provider: 'fake',
    model: 'fake-model',
    judge: async (request: JudgeRequest): Promise<JudgeResult> => {
      const user = request.user;
      if (user.includes('a commit without a local test run is rejected')) {
        return pair('direct-contradiction', ['repo:AGENTS.md', WITHIN_A], ['repo:AGENTS.md', WITHIN_B]);
      }
      if (user.includes('uses pnpm exclusively')) {
        return pair('direct-contradiction', ['repo:AGENTS.md', CROSS_A], ['repo:.github/copilot-instructions.md', CROSS_B]);
      }
      if (user.includes('Prototype sandbox')) return noConflict();
      if (user.includes('formatting.mdc')) {
        return pair(crossToolCriterion, ['repo:.cursor/rules/formatting.mdc', TOOL_A], ['repo:.github/copilot-instructions.md', TOOL_B]);
      }
      return { ok: false, note: `unrecognized fixture payload` };
    },
  };
}

test('correct judgments qualify at foundation with a full report', async () => {
  const result = await selfTest(scriptedJudge('cross-tool-divergence'));
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'foundation');
  assert.deepEqual(result.report.levels, [{ id: 'foundation', status: 'passed' }]);
  assert.equal(result.report.fixtures.length, 4);
  assert.ok(result.report.fixtures.every((f) => f.status === 'ok'));
  assert.match(result.report.fixtureSuite, /^sha256:/);
  // The report carries no fixture contents and no prompts.
  const json = JSON.stringify(result.report);
  assert.ok(!json.includes(WITHIN_A));
  assert.ok(!json.includes('<corpus-artifact>'));
});

test('a criterion miss fails the level and reports the mismatch', async () => {
  // The scripted judge labels the cross-tool fixture direct-contradiction —
  // exactly the confusion the exam exists to catch.
  const result = await selfTest(scriptedJudge('direct-contradiction'));
  assert.equal(result.passed, false);
  assert.equal(result.report.achievedLevel, null);
  const miss = result.report.fixtures.find((f) => f.name === 'cross-tool-divergence')!;
  assert.equal(miss.status, 'miss');
  assert.deepEqual(miss.actual?.criteria, ['direct-contradiction']);
});
