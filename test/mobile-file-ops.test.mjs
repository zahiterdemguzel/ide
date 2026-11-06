// The Files tab's pure helpers (mobile/src/lib/file-ops.js): path math, the name
// check behind New file / New folder / Rename, and the latest-wins listing queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinPath, parentPath, baseName, validateEntryName, renamedPath, createLatestQueue,
  extensionOf, isKnownBinaryName, mimeForName, textFromReadReply,
} from '../mobile/src/lib/file-ops.js';

test('path helpers treat "" as the repo root', () => {
  assert.equal(joinPath('', 'a.js'), 'a.js');
  assert.equal(joinPath('src/lib', 'a.js'), 'src/lib/a.js');
  assert.equal(parentPath('src/lib/a.js'), 'src/lib');
  assert.equal(parentPath('a.js'), '');
  assert.equal(baseName('src/lib/a.js'), 'a.js');
  assert.equal(renamedPath('src/lib/a.js', 'b.js'), 'src/lib/b.js');
  assert.equal(renamedPath('a.js', 'b.js'), 'b.js');
});

test('validateEntryName trims and accepts an ordinary name', () => {
  assert.deepEqual(validateEntryName('  run.py '), { ok: true, name: 'run.py' });
});

test('validateEntryName rejects empty, dot and forbidden names', () => {
  for (const bad of ['', '   ', '.', '..', 'a:b', 'a*b', 'a\\b', 'tab\there']) {
    assert.equal(validateEntryName(bad).ok, false, `expected "${bad}" to be rejected`);
  }
});

test('a rename stays in its folder, a create may nest', () => {
  assert.equal(validateEntryName('a/b.txt').ok, false);
  assert.deepEqual(validateEntryName('a/b.txt', { nested: true }), { ok: true, name: 'a/b.txt' });
  assert.equal(validateEntryName('a//b', { nested: true }).ok, false);
  assert.equal(validateEntryName('/abs', { nested: true }).ok, false);
  assert.equal(validateEntryName('a/../b', { nested: true }).ok, false);
});

// A run whose completion the test controls.
function deferredRunner() {
  const calls = [];
  const run = (arg, superseded) => new Promise((resolve) => calls.push({ arg, superseded, resolve }));
  return { calls, run };
}

test('the queue runs one at a time and lets the latest waiting request win', async () => {
  const { calls, run } = deferredRunner();
  const q = createLatestQueue(run);
  q.request('a');
  q.request('b'); // waiting
  q.request('c'); // replaces b
  assert.equal(calls.length, 1);
  assert.equal(calls[0].superseded(), true);
  calls[0].resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.map((c) => c.arg), ['a', 'c']);
  assert.equal(calls[1].superseded(), false);
  calls[1].resolve();
  await q.whenIdle();
  assert.equal(q.busy, false);
});

test('a request made while idle runs immediately, and a throwing run does not wedge the queue', async () => {
  const seen = [];
  const q = createLatestQueue(async (arg) => {
    seen.push(arg);
    if (arg === 'boom') throw new Error('nope');
  });
  q.request('boom');
  await q.whenIdle();
  q.request('next');
  await q.whenIdle();
  assert.deepEqual(seen, ['boom', 'next']);
});

test('extensionOf lower-cases and ignores dotfiles and folders', () => {
  assert.equal(extensionOf('build/app-release.APK'), 'apk');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(extensionOf('Makefile'), '');
  assert.equal(extensionOf('v1.2/README'), '');
});

test('known binary names skip the text viewer; source files do not', () => {
  for (const name of ['app.apk', 'logo.PNG', 'docs/spec.pdf', 'out.zip', 'clip.mp4', 'font.woff2']) {
    assert.equal(isKnownBinaryName(name), true, name);
  }
  for (const name of ['main.js', 'README.md', 'icon.svg', 'data.json', 'Makefile', 'toString']) {
    assert.equal(isKnownBinaryName(name), false, name);
  }
});

test('mimeForName types known formats and falls back to generic bytes', () => {
  assert.equal(mimeForName('a/b/app.apk'), 'application/vnd.android.package-archive');
  assert.equal(mimeForName('photo.JPG'), 'image/jpeg');
  assert.equal(mimeForName('report.pdf'), 'application/pdf');
  assert.equal(mimeForName('weird.xyz'), 'application/octet-stream');
  assert.equal(mimeForName('constructor'), 'application/octet-stream');
});

test('textFromReadReply rejects failed reads and binaries decoded as text', () => {
  assert.equal(textFromReadReply({ ok: true, text: 'hello' }), 'hello');
  assert.equal(textFromReadReply({ ok: true, text: '' }), '');
  assert.equal(textFromReadReply({ ok: true, text: 'PK\u0003\u0004\u0000\u0000' }), null);
  assert.equal(textFromReadReply({ ok: false, error: 'ENOENT' }), null);
  assert.equal(textFromReadReply(null), null);
});
