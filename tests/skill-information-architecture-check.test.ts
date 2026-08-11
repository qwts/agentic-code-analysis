import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../src/checks/skill-information-architecture/index.ts';
import type { SkillInformationArchitectureVerdict } from '../src/checks/skill-information-architecture/judge-io.ts';
import type { JudgeClient } from '../src/core/judge-client.ts';
import { VerdictCache } from '../src/core/verdict-cache.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aca-skill-ia-check-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SKILL = '---\nname: git\ndescription: Git routines.\n---\n# Routine\n\nRun checkout and pull.\n';
function client(): JudgeClient & { calls: string[] } {
  const calls: string[] = [];
  return { provider: 'stub', model: 'stub-model', calls, judge: async ({ user }) => { calls.push(user); return { ok: true, verdict: { assessment: 'well-structured', findings: [], reasoning_summary: 'cohesive' } }; } };
}
const context = (root: string, files: string[], judge: JudgeClient) => ({ repoRoot: root, baseRef: 'origin/main', files, client: judge, cache: new VerdictCache(join(root, '.cache', 'aca'), check.name) });

test('a resource target selects one physical package; identical rerun is a cache hit', async () => {
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL, '.agents/skills/git/references/rebase.md': '# Rebase\n' });
  try {
    const judge = client();
    const first = await check.run(context(root, ['.agents/skills/git/references/rebase.md'], judge)) as SkillInformationArchitectureVerdict[];
    assert.equal(first.length, 1);
    assert.equal(first[0]!.file, '.agents/skills/git/SKILL.md');
    assert.equal(first[0]!.packageId, 'repo:.agents/skills/git');
    const second = await check.run(context(root, ['.agents/skills/git'], judge));
    assert.equal(judge.calls.length, 1);
    assert.equal(second[0]!.cached, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar change selects the package and invalidates its semantic cache key', async () => {
  const sidecar = (frequency: number) => JSON.stringify({ schemaVersion: 1, packages: { 'repo:.agents/skills/git': { scenarios: [{ id: 'routine', description: 'Routine.', frequency }] } } });
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL, '.aca/skill-information-architecture.json': sidecar(0.8) });
  try {
    const judge = client();
    await check.run(context(root, ['.aca/skill-information-architecture.json'], judge));
    writeFileSync(join(root, '.aca/skill-information-architecture.json'), sidecar(0.9));
    await check.run(context(root, ['.aca/skill-information-architecture.json'], judge));
    assert.equal(judge.calls.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicitly targeted unsupported SKILL.md warns mechanically with no spend', async () => {
  const root = repo({ '.cursor/skills/git/SKILL.md': SKILL });
  try {
    const judge = client();
    const verdicts = await check.run(context(root, ['.cursor/skills/git/SKILL.md'], judge));
    assert.equal(judge.calls.length, 0);
    assert.equal(verdicts[0]!.verdict, 'warn');
    assert.match(verdicts[0]!.note!, /not a corpus-bound/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an incomplete package warns without judge spend', async () => {
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL, '.agents/skills/git/assets/logo.png': 'opaque by extension' });
  try {
    const judge = client();
    const verdicts = await check.run(context(root, ['.agents/skills/git'], judge)) as SkillInformationArchitectureVerdict[];
    assert.equal(judge.calls.length, 0);
    assert.equal(verdicts[0]!.verdict, 'warn');
    assert.equal(verdicts[0]!.cached, false);
    assert.match(verdicts[0]!.note!, /incomplete.*not judged/);
    assert.deepEqual(verdicts[0]!.omissions, [{ path: '.agents/skills/git/assets/logo.png', reason: 'opaque', chars: 19 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config exclude globs keep planted fixture skill trees out of the package universe', async () => {
  const root = repo({
    'aca.config.json': JSON.stringify({ include: ['**'], exclude: ['tests/fixtures/**'] }),
    '.agents/skills/git/SKILL.md': SKILL,
    'tests/fixtures/skills/repo/.agents/skills/planted/SKILL.md': SKILL,
  });
  try {
    const judge = client();
    const verdicts = await check.run(context(root, ['.'], judge)) as SkillInformationArchitectureVerdict[];
    assert.deepEqual(verdicts.map((v) => v.file), ['.agents/skills/git/SKILL.md']);
    assert.equal(judge.calls.length, 1, 'the planted package costs no judge call');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('degraded judge results never cache', async () => {
  const root = repo({ '.agents/skills/git/SKILL.md': SKILL });
  try {
    let calls = 0;
    const judge: JudgeClient = { provider: 'stub', model: 'stub-model', judge: async () => { calls += 1; return { ok: false, note: 'transient' }; } };
    await check.run(context(root, ['.'], judge));
    await check.run(context(root, ['.'], judge));
    assert.equal(calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
