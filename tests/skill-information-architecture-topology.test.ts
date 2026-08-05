import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInstructionCorpus } from '../src/corpora/instructions/index.ts';
import { routesOf, sectionsOf } from '../src/checks/skill-information-architecture/markdown-structure.ts';
import { buildPayload } from '../src/checks/skill-information-architecture/payload.ts';
import { isOpaqueResource } from '../src/checks/skill-information-architecture/resource-kind.ts';
import { buildSkillPackages, selectSkillPackages } from '../src/checks/skill-information-architecture/skill-topology.ts';
import { loadTaskEvidence, parseTaskEvidence, SIDECAR_PATH } from '../src/checks/skill-information-architecture/task-evidence.ts';
import { ConfigError } from '../src/core/config.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-skill-ia-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SKILL = `---
name: git
description: Git routines.
---
# Routine

Run checkout and pull. For rebase recovery, read [the workflow](references/rebase.md).
`;

test('public corpus projections form one package with body-stage costs, routes, and resources', async () => {
  const root = repo({
    '.agents/skills/git/SKILL.md': SKILL,
    '.agents/skills/git/references/rebase.md': '# Rebase\n\nAbort when intent is unclear.\n',
  });
  try {
    const packages = buildSkillPackages(await discoverInstructionCorpus({ repoRoot: root }));
    assert.equal(packages.length, 1);
    const pkg = packages[0]!;
    assert.equal(pkg.packageId, 'repo:.agents/skills/git');
    assert.equal(pkg.body.startsWith('# Routine'), true, 'frontmatter is not charged as activated body');
    assert.ok(pkg.bodyTokens < (await discoverInstructionCorpus({ repoRoot: root })).files.find((file) => file.path.endsWith('SKILL.md'))!.fullFile.count);
    assert.equal(pkg.routes[0]!.status, 'resolved');
    assert.equal(pkg.resources[0]!.potentialTokens! > 0, true);
    assert.equal(pkg.complete, true);
    assert.ok(pkg.loads.some((load) => load.projection === 'metadata'));
    assert.ok(pkg.loads.some((load) => load.projection === 'body' && load.activation === 'model-decision'));
    assert.deepEqual(selectSkillPackages(packages, ['.agents/skills/git/references/rebase.md'], SIDECAR_PATH), packages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route extraction is fence-aware and distinguishes missing, escaping, and variable targets', () => {
  const dir = '.agents/skills/git';
  const members = new Set([`${dir}/SKILL.md`, `${dir}/references/rebase.md`]);
  const content = `# Routes
[rebase](references/rebase.md)
[rebase reference][rebase]
[rebase]: references/rebase.md
\`references/missing.md\`
\`../outside.md\`
\`${'${OTHER_SKILL_DIR}'}/references/x.md\`
\`\`\`
references/ignored.md
\`\`\`
`;
  const routes = routesOf(`${dir}/SKILL.md`, content, dir, members);
  assert.deepEqual(routes.map((route) => route.status), ['resolved', 'resolved', 'resolved', 'missing', 'target-unverifiable']);
  assert.equal(sectionsOf(content)[0]!.heading, 'Routes');
});

test('opaque classification protects binary evidence but accepts extensionless UTF-8 text', () => {
  assert.equal(isOpaqueResource('assets/logo.png', 'apparently text'), true);
  assert.equal(isOpaqueResource('assets/blob', 'abc\0def'), true);
  assert.equal(isOpaqueResource('references/guide', 'Résumé guidance\n'), false);
});

test('corpus diagnostics distinguish unavailable resources from genuinely empty files', async () => {
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL, '.agents/skills/git/references/empty.md': '' });
  const external = repo({ 'outside.md': 'secret\n' });
  try {
    symlinkSync(join(external, 'outside.md'), join(root, '.agents/skills/git/references/unavailable.md'));
    const pkg = buildSkillPackages(await discoverInstructionCorpus({ repoRoot: root }))[0]!;
    assert.equal(pkg.resources.find((resource) => resource.path.endsWith('empty.md'))!.available, true);
    assert.equal(pkg.resources.find((resource) => resource.path.endsWith('unavailable.md'))!.available, false);
    assert.equal(pkg.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('resolved resource cycles make the topology incomplete', async () => {
  const root = repo({
    '.agents/skills/git/SKILL.md': `${SKILL}\nRead [A](references/a.md).\n`,
    '.agents/skills/git/references/a.md': '# A\n\nRead [B](b.md).\n',
    '.agents/skills/git/references/b.md': '# B\n\nRead [A](a.md).\n',
  });
  try {
    assert.equal(buildSkillPackages(await discoverInstructionCorpus({ repoRoot: root }))[0]!.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar grounding is strict, package-contained, and part of the bounded payload', async () => {
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL, '.agents/skills/git/references/rebase.md': '# Rebase\n' });
  try {
    const pkg = buildSkillPackages(await discoverInstructionCorpus({ repoRoot: root }))[0]!;
    const raw = {
      schemaVersion: 1,
      packages: {
        [pkg.packageId]: { scenarios: [{ id: 'routine', description: 'Switch and update.', frequency: 0.8, expectedResources: [] }] },
      },
    };
    const evidence = parseTaskEvidence(raw, pkg);
    assert.equal(evidence.basis, 'workload-grounded');
    assert.ok(buildPayload(pkg, evidence).text.includes('"scenario'));
    assert.throws(
      () => parseTaskEvidence({ schemaVersion: 1, packages: { [pkg.packageId]: { scenarios: [{ id: 'bad', description: 'bad', expectedResources: ['../../escape'] }] } } }, pkg),
      ConfigError,
    );
    const portable = parseTaskEvidence({
      schemaVersion: 1,
      packages: { [pkg.packageId]: { scenarios: [{
        id: 'portable', description: 'Read the rebase section.',
        expectedResources: ['references\\rebase.md#recovery'], observedReads: ['references/rebase.md'],
      }] } },
    }, pkg);
    assert.deepEqual(portable.scenarios[0]!.expectedResources, [`${pkg.packageDir}/references/rebase.md`]);
    assert.deepEqual(portable.scenarios[0]!.observedReads, [`${pkg.packageDir}/references/rebase.md`]);
    assert.throws(
      () => parseTaskEvidence({ schemaVersion: 1, packages: { [pkg.packageId]: { scenarios: [{ id: 'drive', description: 'bad', expectedResources: ['C:\\repo\\guide.md'] }] } } }, pkg),
      ConfigError,
    );
    assert.throws(
      () => parseTaskEvidence({ schemaVersion: 1, packages: { [pkg.packageId]: { scenarios: [{ id: 'fragment', description: 'bad', expectedResources: ['#only'] }] } } }, pkg),
      ConfigError,
    );
    assert.throws(
      () => parseTaskEvidence({ schemaVersion: 1, packages: { [pkg.packageId]: { scenarios: [{ id: 'unknown', description: 'bad', expectedResources: ['references/missing.md'] }] } } }, pkg),
      ConfigError,
    );
    assert.equal(loadTaskEvidence(root, [pkg]).get(pkg.packageId)!.basis, 'cohesion-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whole-file payload omission is deterministic and explicit', async () => {
  const root = repo({
    '.agents/skills/git/SKILL.md': SKILL,
    '.agents/skills/git/references/a.md': 'a'.repeat(5_000),
    '.agents/skills/git/references/b.md': 'b'.repeat(5_000),
  });
  try {
    const pkg = buildSkillPackages(await discoverInstructionCorpus({ repoRoot: root }))[0]!;
    const evidence = { schemaVersion: 1 as const, basis: 'cohesion-only' as const, scenarios: [] };
    const payload = buildPayload(pkg, evidence, 2_000);
    assert.ok(payload.omissions.length > 0);
    assert.ok(payload.omissions.every((entry) => entry.reason === 'input-bound'));
    for (const omission of payload.omissions) assert.ok(!payload.text.includes(`${omission.path}\",\"content`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
