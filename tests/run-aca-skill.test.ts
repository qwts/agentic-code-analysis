import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseFrontmatter } from '../src/corpora/instructions/frontmatter.ts';
import { discoverInstructionCorpus } from '../src/corpora/instructions/index.ts';
import { buildSkillPackages } from '../src/checks/skill-information-architecture/skill-topology.ts';
import { parseTaskEvidence } from '../src/checks/skill-information-architecture/task-evidence.ts';

const ROOT = join(import.meta.dirname, '..');
const SKILL_DIR = join(ROOT, '.agents', 'skills', 'run-aca');

test('run-aca skill has a minimal valid package contract', () => {
  const source = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const frontmatter = parseFrontmatter(source);
  assert.ok(frontmatter.present && !('error' in frontmatter));
  if (!frontmatter.present || 'error' in frontmatter) return;
  assert.deepEqual(Object.keys(frontmatter.fields).sort(), ['description', 'name']);
  assert.equal(frontmatter.fields['name'], 'run-aca');
  const description = frontmatter.fields['description'];
  assert.equal(typeof description, 'string');
  assert.match(description as string, /run and interpret agentic-code-analysis \(ACA\)/i);
  assert.match(description as string, /self-test/);
  assert.match(description as string, /gate-down/);
  assert.match(description as string, /Do not use for generic linting or code review/);

  const topLevel = readdirSync(SKILL_DIR).sort();
  assert.deepEqual(topLevel, ['SKILL.md', 'agents', 'references', 'scripts']);
  for (const forbidden of ['README.md', 'INSTALLATION_GUIDE.md', 'QUICK_REFERENCE.md', 'CHANGELOG.md']) {
    assert.ok(!topLevel.includes(forbidden), `${forbidden} must not enter the skill package`);
  }
});

test('run-aca interface metadata stays aligned with the skill', () => {
  const metadata = parse(readFileSync(join(SKILL_DIR, 'agents', 'openai.yaml'), 'utf8')) as {
    interface?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(metadata), ['interface']);
  assert.deepEqual(metadata.interface, {
    display_name: 'Run ACA',
    short_description: 'Run and interpret ACA semantic checks',
    default_prompt: 'Use $run-aca to choose and run the appropriate ACA check on this repository.',
  });
});

test('run-aca activated body directly routes its only conditional reference', () => {
  const source = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(source, /Read \[the verdict contract\]\(references\/verdict-contract\.md\) whenever/);
  assert.match(source, /scripts\/run-aca --help/);
  assert.match(source, /Advisory exit 0 does not mean clean/);
  assert.match(source, /Do not add `--enforce` unless/);
});

test('run-aca is a complete workload-grounded package in the live corpus', async () => {
  const corpus = await discoverInstructionCorpus({ repoRoot: ROOT });
  const skill = buildSkillPackages(corpus).find((item) => item.packageId === 'repo:.agents/skills/run-aca');
  assert.ok(skill);
  assert.equal(skill!.complete, true);
  assert.ok(skill!.routes.some((route) => route.resolvedPath === '.agents/skills/run-aca/scripts/run-aca'));
  assert.ok(skill!.routes.some((route) => route.resolvedPath === '.agents/skills/run-aca/references/verdict-contract.md'));

  const raw = JSON.parse(readFileSync(join(ROOT, '.aca', 'skill-information-architecture.json'), 'utf8'));
  const evidence = parseTaskEvidence(raw, skill!);
  assert.equal(evidence.basis, 'workload-grounded');
  assert.deepEqual(
    evidence.scenarios.map((scenario) => scenario.id),
    [
      'single-file-analysis',
      'diff-or-doc-analysis',
      'skill-package-analysis',
      'qualify-route',
      'gate-down-interpretation',
      'explicit-enforcement',
    ],
  );
});
