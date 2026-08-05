import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { matchExpectation, validateManifest } from '../src/checks/agent-context-cost/calibration.ts';
import type { AgentContextCostVerdict } from '../src/checks/agent-context-cost/judge-io.ts';
import { selfTest } from '../src/checks/agent-context-cost/self-test.ts';
import { ConfigError } from '../src/core/config.ts';
import type { JudgeClient } from '../src/core/judge-client.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 2,
    requiredLevel: 'foundation',
    levels: [{ id: 'foundation' }],
    fixtures: [
      {
        name: 'one',
        level: 'foundation',
        file: 'CLAUDE.md',
        content: 'one.md',
        sha256: sha('content\n'),
        expect: { assessment: 'dense', verdict: 'pass' },
      },
    ],
    ...overrides,
  };
}

const contentOf = (file: string): string | undefined => (file === 'one.md' ? 'content\n' : undefined);

test('manifest validation: tampered checksum, traversal names, unknown labels all error before any judge call', () => {
  assert.ok(validateManifest(manifest(), contentOf));
  const tampered = manifest() as { fixtures: { sha256: string }[] };
  tampered.fixtures[0]!.sha256 = sha('other\n');
  assert.throws(() => validateManifest(tampered, contentOf), ConfigError);

  const traversal = manifest() as { fixtures: { content: string }[] };
  traversal.fixtures[0]!.content = '../escape.md';
  assert.throws(() => validateManifest(traversal, contentOf), ConfigError);

  const badCriterion = manifest() as { fixtures: { expect: Record<string, unknown> }[] };
  badCriterion.fixtures[0]!.expect = { assessment: 'padded', verdict: 'fail', criteriaAnyOf: ['not-a-criterion'] };
  assert.throws(() => validateManifest(badCriterion, contentOf), ConfigError);

  assert.throws(() => validateManifest(manifest({ requiredLevel: 'missing' }), contentOf), ConfigError);
  assert.throws(() => validateManifest(manifest({ levels: [{ id: 'foundation' }, { id: 'empty' }] }), contentOf), ConfigError, 'a level cannot pass vacuously');
});

test('matchExpectation: criterion needs a real finding, action list matches any finding', () => {
  const verdict = (over: Partial<AgentContextCostVerdict>): AgentContextCostVerdict => ({
    file: 'CLAUDE.md',
    verdict: 'fail',
    cached: false,
    violations: [],
    assessment: 'padded',
    findings: [
      { criterion: 'low-density-prose', excerpt: 'hedge', action: 'rewrite', replacement: 'tight', rationale: 'why', estimatedSavings: 3 },
    ],
    ...over,
  });
  const expect = { assessment: 'padded', verdict: 'fail' as const, criteriaAnyOf: ['low-density-prose'] };
  assert.ok(matchExpectation(expect, verdict({})));
  assert.ok(!matchExpectation(expect, verdict({ assessment: 'dense', verdict: 'pass' })));
  assert.ok(!matchExpectation({ ...expect, criteriaAnyOf: ['oversized-example'] }, verdict({})));
  assert.ok(!matchExpectation(expect, verdict({ findings: [] })));
  assert.ok(matchExpectation({ ...expect, actionsAnyOf: ['rewrite'] }, verdict({})));
  assert.ok(!matchExpectation({ ...expect, actionsAnyOf: ['move-to-hook'] }, verdict({})));
});

/** Oracle client: recognizes each shipped fixture by its heading and replies
 * with the expected shape, quoting a verbatim excerpt so host verification
 * passes. */
function oracleClient(): JudgeClient {
  return {
    provider: 'stub',
    model: 'stub-model',
    judge: async ({ user }) => {
      const content = user.split('<instruction-content>\n')[1]!.split('\n</instruction-content>')[0]!;
      const padded = (criterion: string, action: string, destination = '') => ({
        ok: true as const,
        verdict: {
          assessment: 'padded',
          value_summary: 'little',
          findings: [{ criterion, excerpt: content.split('\n')[0]!, action, replacement: '', destination, rationale: 'fixture oracle' }],
          reasoning_summary: 'rs',
        },
      });
      if (content.includes('# Working constraints')) {
        return { ok: true, verdict: { assessment: 'dense', value_summary: 'tribal', findings: [], reasoning_summary: 'rs' } };
      }
      if (content.includes('# Style rules')) return padded('mechanically-enforceable', 'move-to-hook', 'eslint');
      if (content.includes('# Commit messages')) return padded('oversized-example', 'delete');
      return padded('discoverable-restatement', 'delete');
    },
  };
}

test('self-test qualifies on the oracle client and reports the full ladder', async () => {
  const result = await selfTest(oracleClient());
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.report.qualified, true);
  assert.equal(result.report.achievedLevel, 'coverage');
  assert.deepEqual(
    result.report.levels.map((level) => level.status),
    ['passed', 'passed'],
  );
  assert.match(result.report.fixtureSuite, /^sha256:/);
  assert.equal(result.report.fixtures.length, 4);
});

test('a foundation miss stops the exam: coverage is skipped, never billed', async () => {
  let calls = 0;
  const allDense: JudgeClient = {
    provider: 'stub',
    model: 'stub-model',
    judge: async () => {
      calls += 1;
      return { ok: true, verdict: { assessment: 'dense', value_summary: '', findings: [], reasoning_summary: 'rs' } };
    },
  };
  const result = await selfTest(allDense);
  assert.equal(result.passed, false);
  assert.equal(result.report.achievedLevel, null);
  assert.deepEqual(
    result.report.levels.map((level) => level.status),
    ['failed', 'skipped'],
  );
  assert.equal(calls, 2, 'only the foundation fixtures were judged');
  assert.ok(result.lines.some((line) => line.startsWith('skip [coverage]')));
});
