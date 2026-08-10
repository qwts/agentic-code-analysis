// Renders collected --self-test --json outputs as one qualification table.
// Every selected check gets a row: a check whose runner died before writing a
// result is evidence about the run, and omitting it would let a partial matrix
// failure read as a clean sweep.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SelfTestResultFile {
  /** File stem, used only when the payload does not name its own check. */
  name: string;
  raw: string;
}

interface Row {
  check: string;
  provider: string;
  model: string;
  promptVersion: string;
  required: string;
  achieved: string;
  qualified: string;
}

const blank = (check: string, qualified: string): Row => ({
  check,
  provider: '—',
  model: '—',
  promptVersion: '—',
  required: '—',
  achieved: '—',
  qualified,
});

export function summarize(results: readonly SelfTestResultFile[], selected: readonly string[]): string[] {
  const rows = new Map<string, Row>();

  for (const result of results) {
    const raw = result.raw.trim();
    if (raw === '') {
      rows.set(result.name, blank(result.name, 'no output'));
      continue;
    }
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const check = String(body['check'] ?? result.name);
      // A check without a graded manifest reports only pass/fail (ACA-0012 is
      // not implemented for every check yet). Reading its success as "not
      // qualified" would understate a route that in fact passed.
      const graded = body['qualified'] !== undefined;
      const passed = graded ? body['qualified'] === true : body['passed'] === true;
      rows.set(check, {
        check,
        provider: String(body['provider'] ?? '—'),
        model: String(body['model'] ?? '—'),
        promptVersion: String(body['promptVersion'] ?? '—'),
        required: graded ? String(body['requiredLevel'] ?? '—') : 'ungraded',
        achieved: graded ? String(body['achievedLevel'] ?? 'none') : 'ungraded',
        qualified: passed ? 'yes' : 'no',
      });
    } catch {
      rows.set(result.name, blank(result.name, 'unparsable'));
    }
  }

  for (const check of selected) {
    if (!rows.has(check)) rows.set(check, blank(check, 'no result'));
  }

  const ordered = [...rows.values()].sort((left, right) => left.check.localeCompare(right.check));
  const lines: string[] = [
    '| check | provider | model | prompt | required | achieved | qualified |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of ordered) {
    lines.push(`| ${row.check} | ${row.provider} | ${row.model} | ${row.promptVersion} | ${row.required} | ${row.achieved} | ${row.qualified} |`);
  }

  const missing = ordered.filter((row) => ['no result', 'no output', 'unparsable'].includes(row.qualified));
  lines.push('');
  lines.push(`${ordered.filter((row) => row.qualified === 'yes').length}/${ordered.length} qualified.`);
  if (missing.length > 0) {
    lines.push('');
    lines.push(`${missing.length} check(s) produced no usable result: ${missing.map((row) => row.check).join(', ')}.`);
    lines.push('A missing row is a failed or skipped runner, not a passing route.');
  }
  lines.push('');
  lines.push('Rows marked `ungraded` have no graded fixture manifest and report only');
  lines.push('pass/fail. Self-tests are live and bypass the verdict cache, so these rows');
  lines.push('measure this exact provider/model/prompt tuple, not the check itself.');
  return lines;
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

function main(): void {
  const root = process.argv[2];
  if (root === undefined) {
    console.error('usage: node scripts/qualification-summary.ts <artifact-dir> [selected-checks-json]');
    process.exit(2);
  }

  let selected: string[] = [];
  const selectedArg = process.argv[3];
  if (selectedArg !== undefined && selectedArg.trim() !== '') {
    const parsed: unknown = JSON.parse(selectedArg);
    if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
      console.error('selected-checks-json must be a JSON array of check names');
      process.exit(2);
    }
    selected = parsed as string[];
  }

  let paths: string[] = [];
  try {
    paths = collect(root).sort();
  } catch {
    paths = [];
  }
  const results = paths.map((path) => ({
    name: path.split('/').at(-1)!.replace(/\.json$/, ''),
    raw: readFileSync(path, 'utf8'),
  }));

  for (const line of summarize(results, selected)) console.log(line);
}

if (process.argv[1]?.endsWith('qualification-summary.ts')) main();
