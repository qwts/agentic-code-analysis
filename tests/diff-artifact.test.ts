import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addedLineIndex,
  diffArtifactFromGit,
  diffArtifactFromTrees,
  renderPayload,
  type DiffArtifact,
} from '../src/core/diff-artifact.ts';
import { ConfigError } from '../src/core/config.ts';

function tempRepo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'aca-diff-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  return { root, git };
}

test('git artifact: statuses, rename identity, head line numbers, deterministic order', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'line1\nline2\nline3\n');
  writeFileSync(join(root, 'keep.ts'), 'untouched\n');
  writeFileSync(join(root, 'old-name.ts'), 'export const stable = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  // Committed modification, staged new file, pure rename, working-tree edit.
  writeFileSync(join(root, 'a.ts'), 'line1\nline2 changed\nline3\nline4\n');
  git('mv', 'old-name.ts', 'new-name.ts');
  git('commit', '-qam', 'work');
  writeFileSync(join(root, 'fresh.ts'), 'brand new\n');
  git('add', 'fresh.ts');
  writeFileSync(join(root, 'keep.ts'), 'untouched\nworking tree only\n');

  const files = ['a.ts', 'fresh.ts', 'new-name.ts', 'keep.ts'];
  const artifact = diffArtifactFromGit(root, 'main', files);

  assert.deepEqual(
    artifact.files.map((f) => [f.path, f.status]),
    [
      ['a.ts', 'modified'],
      ['fresh.ts', 'added'],
      ['keep.ts', 'modified'],
      ['new-name.ts', 'renamed'],
    ],
  );
  assert.equal(artifact.files.find((f) => f.path === 'new-name.ts')!.renamedFrom, 'old-name.ts');

  const anchors = addedLineIndex(artifact);
  assert.deepEqual([...anchors.get('a.ts')!].sort(), [2, 4], 'modified file anchors are the head lines the diff added');
  assert.deepEqual([...anchors.get('fresh.ts')!], [1]);
  assert.deepEqual([...anchors.get('keep.ts')!], [2], 'working-tree-only edits are part of the change');
  assert.equal(anchors.has('new-name.ts'), false, 'a pure rename adds no lines');
});

test('git artifact: scope filters by head path; unresolvable base is a config error', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'a.ts'), 'one\n');
  writeFileSync(join(root, 'b.ts'), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(root, 'a.ts'), 'one changed\n');
  writeFileSync(join(root, 'b.ts'), 'two changed\n');

  const artifact = diffArtifactFromGit(root, 'main', ['a.ts']);
  assert.deepEqual(
    artifact.files.map((f) => f.path),
    ['a.ts'],
  );
  assert.throws(() => diffArtifactFromGit(root, 'no-such-ref', ['a.ts']), ConfigError);
});

test('tree artifact: added/deleted/modified with correct hunk numbering; identical files skipped', () => {
  const before = new Map([
    ['gone.ts', 'so long\n'],
    ['same.ts', 'stable\n'],
    ['edit.ts', 'a\nb\nc\nd\ne\nf\ng\nh\n'],
  ]);
  const after = new Map([
    ['same.ts', 'stable\n'],
    ['edit.ts', 'a\nb\nc\nd\nX\nf\ng\nh\n'],
    ['born.ts', 'first\nsecond\n'],
  ]);
  const artifact = diffArtifactFromTrees(before, after);
  assert.deepEqual(
    artifact.files.map((f) => [f.path, f.status]),
    [
      ['born.ts', 'added'],
      ['edit.ts', 'modified'],
      ['gone.ts', 'deleted'],
    ],
  );
  const edit = artifact.files.find((f) => f.path === 'edit.ts')!;
  assert.equal(edit.hunks.length, 1);
  const hunk = edit.hunks[0]!;
  assert.equal(hunk.newStart, 2, 'three context lines around the change');
  assert.deepEqual(
    hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 2, 2],
      ['context', 3, 3],
      ['context', 4, 4],
      ['del', 5, null],
      ['add', null, 5],
      ['context', 6, 6],
      ['context', 7, 7],
      ['context', 8, 8],
    ],
  );
  assert.deepEqual([...addedLineIndex(artifact).get('born.ts')!], [1, 2]);
});

test('payload bound: an oversized file is omitted whole, named with head hunk ranges — never silently truncated', () => {
  const artifact: DiffArtifact = diffArtifactFromTrees(
    new Map([['small.ts', 'a\n']]),
    new Map([
      ['small.ts', 'a\nb\n'],
      ['huge.ts', Array.from({ length: 200 }, (_, i) => `line number ${i}`).join('\n') + '\n'],
    ]),
  );
  const full = renderPayload(artifact, 1_000_000);
  assert.deepEqual(full.included, ['huge.ts', 'small.ts']);
  assert.deepEqual(full.omitted, []);
  assert.match(full.text, /\+\s+2\| b/, 'added lines carry their head line number');

  const bounded = renderPayload(artifact, 500);
  assert.deepEqual(bounded.included, ['small.ts'], 'greedy skip-and-continue still includes later files that fit');
  assert.deepEqual(bounded.omitted, [{ path: 'huge.ts', hunks: ['+1,200'] }]);
  assert.ok(!bounded.text.includes('line number 42'), 'omitted content must not leak into the payload');

  // The bound is exact: separators count too (Copilot, PR #36).
  assert.ok(!full.text.includes('\n\n\n'), 'exactly one blank line between file sections');
  assert.match(full.text, /\n\n=== /);
  for (const bound of [10, 100, 500, full.text.length, full.text.length + 2]) {
    assert.ok(renderPayload(artifact, bound).text.length <= bound, `rendered text must fit the ${bound}-char bound`);
  }
});

test('binary diffs keep their identity from the diff header and render as binary, never silently vanish', () => {
  const { root, git } = tempRepo();
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  writeFileSync(join(root, 'a.ts'), 'code\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(root, 'blob.bin'), Buffer.from([9, 8, 7, 0, 255, 0, 1]));

  const artifact = diffArtifactFromGit(root, 'main', ['blob.bin']);
  assert.deepEqual(
    artifact.files.map((f) => [f.path, f.status, f.binary, f.hunks.length]),
    [['blob.bin', 'modified', true, 0]],
  );
  const payload = renderPayload(artifact, 1_000_000);
  assert.deepEqual(payload.included, ['blob.bin']);
  assert.match(payload.text, /=== blob\.bin \(modified\)\n\(binary — content not shown\)/);
});
