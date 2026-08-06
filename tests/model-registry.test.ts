import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The zero-dependency governance helper is intentionally plain ESM.
import { routingFor } from '../tools/models/registry.mjs';

type RoutingRow = { vendor: string; plan: string; build: string; available_in: string };

const registryPath = path.resolve('governance/agent-models.json');

test('issue routing withholds hand-seeded model names until a refresh verifies them', () => {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const anthropic = (routingFor(registry, 'T1') as RoutingRow[]).find((row) => row.vendor === 'anthropic');
  assert.equal(anthropic?.plan, 'unverified — do not guess');
  assert.equal(anthropic?.build, 'unverified — do not guess');

  const verified = structuredClone(registry);
  verified.tiers.T1.vendors.anthropic.plan = { model: 'source-backed-model', reasoning: 'high', status: 'verified' };
  assert.equal((routingFor(verified, 'T1') as RoutingRow[]).find((row) => row.vendor === 'anthropic')?.plan, 'source-backed-model (reasoning high)');
});
