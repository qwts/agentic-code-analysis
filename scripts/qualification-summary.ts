// Renders collected --self-test --json outputs as one qualification table.
// A check whose run produced no parsable report still gets a row: a missing
// result is evidence about the route, not an absence of evidence.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Row {
  check: string;
  provider: string;
  model: string;
  promptVersion: string;
  required: string;
  achieved: string;
  qualified: string;
}

function collect(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...collect(path));
    else if (entry.endsWith('.json')) found.push(path);
  }
  return found;
}

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: node scripts/qualification-summary.ts <artifact-dir>');
  process.exit(2);
}

const rows: Row[] = [];
for (const path of collect(root).sort()) {
  const raw = readFileSync(path, 'utf8').trim();
  const name = path.split('/').at(-1)!.replace(/\.json$/, '');
  if (raw === '') {
    rows.push({ check: name, provider: '—', model: '—', promptVersion: '—', required: '—', achieved: '—', qualified: 'no output' });
    continue;
  }
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    rows.push({
      check: String(body['check'] ?? name),
      provider: String(body['provider'] ?? '—'),
      model: String(body['model'] ?? '—'),
      promptVersion: String(body['promptVersion'] ?? '—'),
      required: String(body['requiredLevel'] ?? '—'),
      achieved: String(body['achievedLevel'] ?? 'none'),
      qualified: body['qualified'] === true ? 'yes' : 'no',
    });
  } catch {
    rows.push({ check: name, provider: '—', model: '—', promptVersion: '—', required: '—', achieved: '—', qualified: 'unparsable' });
  }
}

console.log('| check | provider | model | prompt | required | achieved | qualified |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
  console.log(`| ${row.check} | ${row.provider} | ${row.model} | ${row.promptVersion} | ${row.required} | ${row.achieved} | ${row.qualified} |`);
}
console.log('');
console.log(`${rows.filter((row) => row.qualified === 'yes').length}/${rows.length} qualified.`);
console.log('');
console.log('Self-tests are live and bypass the verdict cache, so these rows are');
console.log('measurements of this exact provider/model/prompt tuple, not of the check.');
