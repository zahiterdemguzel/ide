const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const extensions = ['step', 'stp', 'dwg', 'fcstd'];

function isCadFile(file) {
  return typeof file === 'string' && extensions.includes(path.extname(file).slice(1).toLowerCase());
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Explicit absolute paths come from desktop file links and the native picker.
// Relative paths belong to the active worktree, including after resolving links.
async function resolveCadFile(root, file) {
  if (!isCadFile(file)) throw new Error('Choose a STEP, DWG, or FreeCAD document.');
  const absolute = path.isAbsolute(file);
  const requested = absolute ? file : path.resolve(root, file);
  if (!absolute && !isInside(root, requested)) throw new Error('Design is outside the active folder.');
  const resolved = await fs.realpath(requested);
  if (!absolute && !isInside(await fs.realpath(root), resolved)) throw new Error('Design is outside the active folder.');
  if (!isCadFile(resolved) || !(await fs.stat(resolved)).isFile()) {
    throw new Error('Choose an existing CAD design file.');
  }
  return resolved;
}

function revisionOf(file, bytes) {
  return createHash('sha256').update(file).update('\0').update(bytes).digest('hex');
}

function cadFormat(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.dwg') return 'dwg';
  if (extension === '.step' || extension === '.stp') return 'step';
  throw new Error('This document requires FreeCAD.');
}

async function readDesign(file) {
  cadFormat(file);
  const bytes = await fs.readFile(file);
  return { bytes, revision: revisionOf(file, bytes) };
}

function validateDesign(file, bytes) {
  const valid = cadFormat(file) === 'dwg'
    ? /^AC\d{4}/.test(bytes.toString('ascii', 0, 6))
    : /ISO-10303-21;/i.test(bytes.toString('ascii', 0, 256))
      && /END-ISO-10303-21;/i.test(bytes.toString('ascii', Math.max(0, bytes.length - 256)));
  if (!valid) throw new Error('The editor returned an invalid design. The file was not saved.');
  return bytes;
}

const saving = new Set();

async function writeDesign(file, bytes, revision) {
  if (saving.has(file)) throw new Error('Another save is in progress.');
  saving.add(file);
  const temp = path.join(path.dirname(file), '.cad-' + randomUUID() + '.tmp');
  try {
    const existing = await fs.stat(file).catch(err => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: existing ? existing.mode : 0o666 });
    if (revision !== undefined && (!existing || revisionOf(file, await fs.readFile(file)) !== revision)) {
      throw new Error('This design changed on disk. Save a copy or reopen it before overwriting.');
    }
    await fs.rename(temp, file);
    return { file, revision: revisionOf(file, bytes) };
  } finally {
    saving.delete(file);
    await fs.rm(temp, { force: true });
  }
}

module.exports = { extensions, isCadFile, resolveCadFile, cadFormat, readDesign, validateDesign, writeDesign };
