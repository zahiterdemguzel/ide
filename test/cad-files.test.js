const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isCadFile, resolveCadFile } = require('../src/main/cad-files');

test('CAD paths resolve inside the worktree or from an explicit absolute path', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-cad-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'worktree');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'drawing.DWG'), '');
  const outside = path.join(tmp, 'part.sTp');
  await fs.writeFile(outside, '');
  assert.equal(await resolveCadFile(root, 'drawing.DWG'), await fs.realpath(path.join(root, 'drawing.DWG')));
  assert.equal(await resolveCadFile(root, outside), await fs.realpath(outside));
  await assert.rejects(resolveCadFile(root, '../part.sTp'), /outside/);
  await assert.rejects(resolveCadFile(root, 'missing.FCStd'), /ENOENT/);
  await assert.rejects(resolveCadFile(root, 'macro.FCMacro'), /Choose/);
  await fs.mkdir(path.join(root, 'directory.step'));
  await assert.rejects(resolveCadFile(root, 'directory.step'), /file/);
  assert.equal(isCadFile('a.step.bak'), false);
});

test('design saves are atomic and reject a stale or cross-file revision', async (t) => {
  const { readDesign, validateDesign, writeDesign } = require('../src/main/cad-files');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-cad-save-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'a.dwg');
  const b = path.join(root, 'b.dwg');
  const original = Buffer.from('AC1015original');
  await fs.writeFile(a, original);
  await fs.writeFile(b, original);
  const design = await readDesign(a);
  const edited = validateDesign(a, Buffer.from('AC1015edited'));
  await assert.rejects(writeDesign(b, edited, design.revision), /changed on disk/);
  assert.throws(() => validateDesign(a, Buffer.alloc(0)), /invalid/);
  assert.throws(() => validateDesign('part.step', design.bytes), /invalid/);
  const saved = await writeDesign(a, edited, design.revision);
  assert.equal(saved.revision, (await readDesign(a)).revision);
  await assert.rejects(writeDesign(a, original, design.revision), /changed on disk/);
  assert.deepEqual(await fs.readFile(a), edited);
  assert.deepEqual(await fs.readdir(root), ['a.dwg', 'b.dwg']);
});
