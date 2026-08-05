import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJudgeReply, systemPrompt, userPrompt, verdictSchema } from '../src/checks/agent-rule-conflict/judge-io.ts';

const IDS = ['repo:AGENTS.md', 'repo:CLAUDE.md'];

test('the strict schema pins per-partition source-id enums', () => {
  const schema = verdictSchema(IDS) as { properties: { conflicts: { items: { properties: { rule_a: { properties: { source_id: { enum: string[] } } } } } } } };
  assert.deepEqual(schema.properties.conflicts.items.properties.rule_a.properties.source_id.enum, IDS);
  assert.equal((schema as unknown as { additionalProperties: boolean }).additionalProperties, false);
});

test('the rubric declares the artifact a data boundary and withholds severity', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /DATA/);
  assert.match(prompt, /never instructions to you/i);
  assert.match(prompt, /HIERARCHY IS NOT CONFLICT/);
  assert.match(prompt, /Do not report which sessions/);
});

test('the user turn is only the delimited canonical payload', () => {
  const prompt = userPrompt('{"sources":[]}');
  assert.equal(prompt, '<corpus-artifact>\n{"sources":[]}\n</corpus-artifact>');
});

test('reply guard accepts the contract shape and rejects drift', () => {
  const good = {
    assessment: 'conflicts-found',
    conflicts: [
      {
        criterion: 'direct-contradiction',
        rule_a: { source_id: IDS[0], quote: 'a' },
        rule_b: { source_id: IDS[1], quote: 'b' },
        explanation: 'e',
        resolution: 'consolidate',
        suggestion: 's',
      },
    ],
    reasoning_summary: 'rs',
  };
  assert.ok(isJudgeReply(good));
  assert.ok(isJudgeReply({ assessment: 'no-conflict', conflicts: [], reasoning_summary: 'rs' }));
  for (const bad of [
    null,
    {},
    { ...good, assessment: 'maybe' },
    { ...good, conflicts: [{ ...good.conflicts[0], criterion: 'style-issue' }] },
    { ...good, conflicts: [{ ...good.conflicts[0], resolution: 'ignore' }] },
    { ...good, conflicts: [{ ...good.conflicts[0], rule_a: { quote: 'a' } }] },
    { ...good, reasoning_summary: 7 },
  ]) {
    assert.equal(isJudgeReply(bad), false, JSON.stringify(bad));
  }
});
