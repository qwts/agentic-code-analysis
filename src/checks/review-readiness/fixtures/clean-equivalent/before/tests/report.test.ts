import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReport } from '../src/report.ts';

test('renders one line per row', () => {
  assert.equal(renderReport([{ name: 'a', total: 1 }]), 'a: 1');
});

test('joins rows with newlines', () => {
  const rows = [
    { name: 'a', total: 1 },
    { name: 'b', total: 2 },
  ];
  assert.equal(renderReport(rows).split('\n').length, 2);
});
