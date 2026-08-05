import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError } from '../src/core/config.ts';
import {
  matchExpectation,
  validateManifest,
  type Expectation,
  type TreeResolver,
} from '../src/checks/agent-rule-conflict/calibration.ts';
import { CORPUS_ROW, type AttributedFinding, type ConflictVerdict } from '../src/checks/agent-rule-conflict/outcome.ts';

const FIXTURES = join(import.meta.dirname, '..', 'src', 'checks', 'agent-rule-conflict', 'fixtures');

function fsResolver(): TreeResolver {
  return {
    listTree(tree) {
      try {
        const root = join(FIXTURES, tree);
        return readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/'))
          .sort();
      } catch {
        return undefined;
      }
    },
    contentOf(tree, path) {
      try {
        return readFileSync(join(FIXTURES, tree, ...path.split('/')), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));

test('the shipped manifest validates against the shipped trees', () => {
  const validated = validateManifest(manifest(), fsResolver());
  assert.equal(validated.requiredLevel, 'foundation');
  assert.equal(validated.fixtures.length, 4);
});

test('integrity errors are configuration errors before any judge call', () => {
  const resolver = fsResolver();
  const tampered = manifest();
  (tampered['fixtures'] as { files: Record<string, string> }[])[0]!.files['repo/AGENTS.md'] = 'f'.repeat(64);
  assert.throws(() => validateManifest(tampered, resolver), ConfigError);

  const traversal = manifest();
  const fixture = (traversal['fixtures'] as { files: Record<string, string> }[])[0]!;
  fixture.files['../escape.md'] = 'a'.repeat(64);
  assert.throws(() => validateManifest(traversal, resolver), /unsafe tree path/);

  // An undeclared file in the tree changes discovery — exact listing only.
  const extra: TreeResolver = {
    listTree: (tree) => [...(resolver.listTree(tree) ?? []), 'repo/EXTRA.md'],
    contentOf: (tree, path) => (path === 'repo/EXTRA.md' ? 'x' : resolver.contentOf(tree, path)),
  };
  assert.throws(() => validateManifest(manifest(), extra), /listing differs/);

  const badCriterion = manifest();
  ((badCriterion['fixtures'] as { expect: { criteriaAnyOf: string[] } }[])[0]!.expect.criteriaAnyOf = ['style-issue']);
  assert.throws(() => validateManifest(badCriterion, resolver), /unknown criteriaAnyOf/);

  const badLevel = manifest();
  badLevel['requiredLevel'] = 'championship';
  assert.throws(() => validateManifest(badLevel, resolver), /not a declared level/);
});

// ---- the oracle ----

const ref = (file: string, quote: string) => ({ sourceId: `repo:${file}`, file, startLine: 3, endLine: 3, offset: 0, quote });

function finding(over: Partial<AttributedFinding> = {}): AttributedFinding {
  return {
    criterion: 'direct-contradiction',
    ruleA: ref('AGENTS.md', 'always npm'),
    ruleB: ref('CLAUDE.md', 'never npm'),
    explanation: 'e',
    resolution: 'consolidate',
    suggestion: 's',
    verdict: 'fail',
    sessionsLoadingBoth: ['copilot-cli@.'],
    sessionsPossiblyLoadingBoth: [],
    semanticsUnverified: false,
    partitionIds: ['whole-corpus'],
    ...over,
  };
}

function verdicts(findings: AttributedFinding[], corpusOver: Partial<ConflictVerdict> = {}): ConflictVerdict[] {
  const rows: ConflictVerdict[] = findings.length > 0
    ? [{ file: findings[0]!.ruleA.file, verdict: findings.some((f) => f.verdict === 'fail') ? 'fail' : 'warn', cached: false, violations: [], findings }]
    : [];
  rows.push({ file: CORPUS_ROW, verdict: 'pass', cached: false, violations: [], assessment: findings.length > 0 ? 'conflicts-found' : 'no-conflict', ...corpusOver });
  return rows;
}

test('the oracle asserts assessment, verdict, criterion grounding, and session emptiness', () => {
  const failExpect: Expectation = { assessment: 'conflicts-found', verdict: 'fail', criteriaAnyOf: ['direct-contradiction'], sharedSessions: 'some' };
  assert.ok(matchExpectation(failExpect, verdicts([finding()])));
  // Criterion label without shared sessions does not satisfy 'some'.
  assert.equal(matchExpectation(failExpect, verdicts([finding({ sessionsLoadingBoth: [], verdict: 'warn' })])), false);
  // Blank quotes are not grounded evidence.
  assert.equal(matchExpectation(failExpect, verdicts([finding({ ruleA: ref('AGENTS.md', ' ') })])), false);

  const warnExpect: Expectation = { assessment: 'conflicts-found', verdict: 'warn', criteriaAnyOf: ['cross-tool-divergence'], sharedSessions: 'none' };
  const crossTool = finding({ criterion: 'cross-tool-divergence', verdict: 'warn', sessionsLoadingBoth: [] });
  assert.ok(matchExpectation(warnExpect, verdicts([crossTool])));
  assert.equal(matchExpectation(warnExpect, verdicts([finding({ criterion: 'cross-tool-divergence', verdict: 'warn' })])), false);

  const passExpect: Expectation = { assessment: 'no-conflict', verdict: 'pass' };
  assert.ok(matchExpectation(passExpect, verdicts([])));
  assert.equal(matchExpectation(passExpect, verdicts([finding()])), false);
  // A degraded corpus row is never a pass.
  assert.equal(matchExpectation(passExpect, verdicts([], { verdict: 'warn', assessment: undefined })), false);
});
