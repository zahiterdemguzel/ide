// The phone's unified-diff parser (mobile/src/lib/diff-parse.js): what Git, History,
// stash and the chat's session diff all draw from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, diffTotals } from '../mobile/src/lib/diff-parse.js';

const TWO_FILES = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,3 @@ function a() {',
  ' keep',
  '-old',
  '+new',
  ' tail',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '\\ No newline at end of file',
  '',
].join('\n');

test('splits a patch into files with counts and line numbers', () => {
  const files = parseUnifiedDiff(TWO_FILES);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  assert.deepEqual(files[0].rows.map((r) => r.kind), ['hunk', 'ctx', 'del', 'add', 'ctx']);
  assert.deepEqual(files[0].rows[2], { kind: 'del', text: 'old', oldLine: 2 });
  assert.deepEqual(files[0].rows[3], { kind: 'add', text: 'new', newLine: 2 });
  assert.equal(files[1].path, 'new.txt');
  assert.equal(files[1].oldPath, undefined);
  assert.equal(files[1].rows.at(-1).kind, 'meta');
  assert.deepEqual(diffTotals(files), { files: 2, additions: 3, deletions: 1 });
});

test('a deleted file keeps its old path as its name', () => {
  const [f] = parseUnifiedDiff('diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
  assert.equal(f.path, 'gone.js');
  assert.equal(f.deletions, 1);
});

test('binary files and renames are recognised', () => {
  const files = parseUnifiedDiff([
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/old.js b/new.js',
    'similarity index 100%',
    'rename from old.js',
    'rename to new.js',
  ].join('\n'));
  assert.equal(files[0].binary, true);
  assert.equal(files[1].path, 'new.js');
  assert.equal(files[1].oldPath, 'old.js');
});

test('hunks without a diff --git header still parse; garbage yields nothing', () => {
  const [f] = parseUnifiedDiff('@@ -5,1 +5,1 @@\n-a\n+b\n');
  assert.equal(f.rows.length, 3);
  assert.equal(f.rows[1].oldLine, 5);
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff(undefined), []);
});
