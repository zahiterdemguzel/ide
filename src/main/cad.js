const { ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getRepoPath } = require('./repo');
const { getWin } = require('./window');
const { extensions, resolveCadFile, cadFormat, readDesign, validateDesign, writeDesign } = require('./cad-files');
const { openInFreeCAD } = require('./cad-freecad');

async function encodeDesign(file, base64) {
  if (typeof base64 !== 'string' || !base64.length) throw new Error('Missing CAD output.');
  const bytes = Buffer.from(base64, 'base64');
  if (cadFormat(file) === 'step') return validateDesign(file, bytes);
  const { dxfToDwg } = require('./cad-dwg-convert');
  return validateDesign(file, await dxfToDwg(bytes));
}

ipcMain.handle('pick-cad-file', async () => {
  const result = await dialog.showOpenDialog(getWin(), {
    properties: ['openFile'],
    filters: [{ name: 'CAD designs', extensions }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('read-cad-design', async (_e, file) => {
  try {
    const abs = await resolveCadFile(getRepoPath(), file);
    const { bytes, revision } = await readDesign(abs);
    const dwg = cadFormat(abs) === 'dwg';
    const payload = dwg ? await require('./cad-dwg-convert').dwgToDxf(bytes) : bytes;
    return { ok: true, file: abs, revision, format: dwg ? 'dxf' : 'step', base64: payload.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-cad-design', async (_e, { file, base64, revision }) => {
  try {
    const abs = await resolveCadFile(getRepoPath(), file);
    if (typeof revision !== 'string') throw new Error('Reopen the design before saving.');
    return { ok: true, ...await writeDesign(abs, await encodeDesign(abs, base64), revision) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-cad-design-as', async (_e, { file, base64, revision }) => {
  try {
    const abs = path.isAbsolute(file) ? file : await resolveCadFile(getRepoPath(), file);
    const format = cadFormat(abs);
    const { dir, name, ext } = path.parse(abs);
    const choice = await dialog.showSaveDialog(getWin(), {
      defaultPath: path.join(dir, name + '-edited' + ext),
      filters: [{ name: format.toUpperCase(), extensions: format === 'step' ? ['step', 'stp'] : ['dwg'] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    const target = await fs.realpath(choice.filePath).catch(err => {
      if (err.code !== 'ENOENT') throw err;
      return choice.filePath;
    });
    if (cadFormat(target) !== format) throw new Error('Choose a filename with the original CAD format.');
    const original = await fs.realpath(abs).catch(() => abs);
    const replacingOriginal = target === original;
    if (replacingOriginal && typeof revision !== 'string') throw new Error('Reopen the design before saving.');
    return { ok: true, ...await writeDesign(target, await encodeDesign(abs, base64), replacingOriginal ? revision : undefined) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('open-cad-file', async (_e, file) => {
  try {
    const abs = await resolveCadFile(getRepoPath(), file);
    await openInFreeCAD(abs);
    return { ok: true, editor: 'FreeCAD' };
  } catch (e) { return { ok: false, error: e.message }; }
});
