import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checks } from '../src/checks/registry.ts';

const README_URL = new URL('../README.md', import.meta.url);
const START = '<!-- aca-check-catalog:start -->';
const END = '<!-- aca-check-catalog:end -->';

function localDocumentUrl(link: string): URL {
  const url = new URL(`../${link}`, import.meta.url);
  url.search = '';
  url.hash = '';
  return url;
}

test('README analysis catalog matches registered names, tiers, and design links', async () => {
  const readme = readFileSync(README_URL, 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  assert.ok(start >= 0 && end > start, 'README must contain one bounded analysis catalog');
  assert.equal(readme.indexOf(START, start + START.length), -1, 'README must contain only one catalog start marker');
  assert.equal(readme.indexOf(END, end + END.length), -1, 'README must contain only one catalog end marker');

  const catalog = readme.slice(start + START.length, end);
  const rows = [...catalog.matchAll(/^\| \[`aca ([a-z0-9-]+)`\]\(([^)]+)\) \| (T[123]) \|/gmu)].map((match) => ({ name: match[1]!, design: match[2]!, tier: match[3]! }));
  const names = rows.map((row) => row.name);

  assert.equal(new Set(names).size, names.length, 'README catalog must not duplicate a check');
  assert.deepEqual(names.toSorted(), [...checks.keys()].toSorted());
  for (const advertised of readme.matchAll(/`aca ([a-z][a-z0-9-]+)`/gu)) {
    assert.equal(checks.has(advertised[1]!), true, `README must not advertise unknown check ${advertised[1]}`);
  }
  for (const row of rows) {
    assert.equal(existsSync(localDocumentUrl(row.design)), true, `${row.name} design link must resolve`);
    assert.equal(row.tier, (await checks.get(row.name)!()).tier, `${row.name} tier must match its registered check`);
  }
});

test('README design-link checks ignore valid query strings and fragments', () => {
  assert.equal(existsSync(localDocumentUrl('docs/design/check-context-footprint.md?plain=1#what-it-judges')), true);
});
