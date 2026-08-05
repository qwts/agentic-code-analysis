import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JudgeClient } from '../src/core/judge-client.ts';
import { selfTest } from '../src/checks/skill-information-architecture/self-test.ts';

function oracle(): JudgeClient & { calls: number } {
  const client: JudgeClient & { calls: number } = {
    provider: 'stub',
    model: 'stub-model',
    calls: 0,
    judge: async ({ user }) => {
      client.calls += 1;
      const raw = user.slice('<skill-package-json>\n'.length, user.lastIndexOf('\n</skill-package-json>'));
      const payload = JSON.parse(raw) as { files: { path: string; content: string }[]; scenarios: { id: string }[] };
      const root = payload.files[0]!;
      const body = root.content;
      const scenario = payload.scenarios[0]?.id ?? '';
      const pass = () => ({ ok: true as const, verdict: { assessment: 'well-structured', findings: [], reasoning_summary: 'fixture oracle' } });
      const fail = (finding: Record<string, unknown>) => ({ ok: true as const, verdict: { assessment: 'needs-restructure', findings: [finding], reasoning_summary: 'fixture oracle' } });
      if (body.includes('# Interactive rebase in detail')) {
        const excerpt = body.split('\n\n')[1]!;
        return fail({
          criterion: 'eager-specialist-detail', source_path: root.path, heading: 'Interactive rebase in detail', excerpt,
          scenario_ids: ['interactive-rebase'], action: 'extract-resource', destination_path: 'references/rebase.md', destination_section: 'Rebase workflow',
          proposal_text: 'For interactive rebase and recovery, read [the rebase workflow](references/rebase.md).', preserve: [], rationale: 'Specialist detail displaces the common routine.',
        });
      }
      if (body.includes('checkout instructions')) {
        const resource = payload.files.find((file) => file.path.endsWith('references/checkout.md'))!;
        const excerpt = resource.content.split('\n\n')[1]!.trim();
        return fail({
          criterion: 'fragmented-core-workflow', source_path: resource.path, heading: 'Checkout', excerpt,
          scenario_ids: ['switch-and-update'], action: 'inline-core', destination_path: root.path, destination_section: 'Routine branch work',
          proposal_text: excerpt, preserve: [], rationale: 'The routine task otherwise requires two resource reads.',
        });
      }
      if (body.includes('Advanced Git details')) {
        return fail({
          criterion: 'weak-disclosure-route', source_path: root.path, heading: 'More information', excerpt: 'Advanced Git details are in `references/rebase.md`.',
          scenario_ids: ['rebase-recovery'], action: 'add-route', destination_path: root.path, destination_section: 'More information',
          proposal_text: 'For interactive rebase, conflicts, or recovery, read [the rebase workflow](references/rebase.md) before acting.', preserve: [], rationale: 'The current cue does not say when the resource is needed.',
        });
      }
      if (body.indexOf('# Repository background') < body.indexOf('# Routine branch work') && body.includes('short lived')) {
        return fail({
          criterion: 'buried-core-guidance', source_path: root.path, heading: 'Routine branch work', excerpt: 'Switch with `git checkout <branch>` and update with `git pull --ff-only`.',
          scenario_ids: ['routine-sync'], action: 'move-earlier', destination_path: root.path, destination_section: 'before Repository background',
          proposal_text: '# Routine branch work\n\nSwitch with `git checkout <branch>` and update with `git pull --ff-only`.', preserve: [], rationale: 'The common routine should precede background.',
        });
      }
      if (scenario === '' && body.includes('# Interactive rebase')) {
        return { ok: true, verdict: { assessment: 'uncertain', findings: [], reasoning_summary: 'No workload evidence grounds relative frequency.' } };
      }
      return pass();
    },
  };
  return client;
}

test('the checksummed package-tree exam qualifies through boundaries', async () => {
  const client = oracle();
  const result = await selfTest(client);
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.report.achievedLevel, 'boundaries');
  assert.equal(result.report.requiredLevel, 'boundaries');
  assert.equal(result.report.fixtureSuite.startsWith('sha256:'), true);
  assert.equal(client.calls, 9);
  assert.deepEqual(result.report.levels.map((level) => level.status), ['passed', 'passed', 'passed']);
});

test('a foundation miss skips higher-level spend', async () => {
  let calls = 0;
  const allPass: JudgeClient = {
    provider: 'stub', model: 'stub-model', judge: async () => {
      calls += 1;
      return { ok: true, verdict: { assessment: 'well-structured', findings: [], reasoning_summary: 'blind' } };
    },
  };
  const result = await selfTest(allPass);
  assert.equal(result.passed, false);
  assert.deepEqual(result.report.levels.map((level) => level.status), ['failed', 'skipped', 'skipped']);
  assert.equal(calls, 2);
});
