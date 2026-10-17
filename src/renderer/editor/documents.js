// The editor's open documents: one Monaco text model per file, with what's on
// disk alongside it so we know when it's dirty and when the disk moved under it.
//
// Files are keyed by their repo-relative path (what the explorer, git pane and
// run toolbar use). A file outside the repo — a language server's go-to-
// definition into a stdlib stub, say — is keyed by its absolute path and opens
// read-only. Each model's URI is the file's absolute `file://` URI, which is
// what language servers expect.
//
// Edits live only in the model until saved. Dirtiness is Monaco's "alternative
// version id" compared with the one recorded at the last save/load: it returns
// to the same value when the user undoes back to the saved state, so undoing all
// edits clears the dirty dot, as in VS Code.

import { languageForFile } from './languages.js';

let monaco = null;
let repoRoot = null;
const docs = new Map(); // file key -> Doc
const listeners = new Set();

export function initDocuments(monacoNs) { monaco = monacoNs; }

// Change listener: cb(doc, reason) with reason 'dirty' | 'reloaded' | 'conflict' | 'saved' | 'disposed'.
export function onDocumentChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(doc, reason) { for (const cb of listeners) cb(doc, reason); }

export function setRepoRoot(root) { repoRoot = root ? root.replace(/[\\/]+$/, '') : null; }
export function getRepoRoot() { return repoRoot; }

export function isAbsolutePath(p) { return /^([A-Za-z]:[\\/]|\/)/.test(p); }

export function absolutePathOf(file) {
  if (isAbsolutePath(file)) return file;
  return repoRoot ? `${repoRoot}/${file}` : file;
}

// Map an absolute path back to our file key (repo-relative when inside the repo).
export function fileKeyForPath(abs) {
  const norm = abs.replace(/\\/g, '/');
  const root = repoRoot && repoRoot.replace(/\\/g, '/');
  if (root) {
    const sameCase = norm.startsWith(root + '/');
    // Windows/macOS file systems are case-insensitive; servers may report a
    // different drive-letter or folder case than we opened the repo with.
    const foldedMatch = norm.toLowerCase().startsWith(root.toLowerCase() + '/');
    if (sameCase || foldedMatch) return norm.slice(root.length + 1);
  }
  return abs;
}

export function fileKeyForUri(uri) { return fileKeyForPath(uri.fsPath); }

export function getDoc(file) { return docs.get(file) || null; }
export function allDocs() { return [...docs.values()]; }
export function docForModel(model) {
  for (const doc of docs.values()) if (doc.model === model) return doc;
  return null;
}

export function isDirty(doc) {
  return !!doc && !doc.model.isDisposed() && doc.model.getAlternativeVersionId() !== doc.savedVersionId;
}

async function readFromDisk(file) {
  return isAbsolutePath(file) ? window.api.readTextAbs(file) : window.api.readText(file);
}

// A null byte means binary — the editor shows a notice instead of mojibake.
export function looksBinary(text) { return text.includes('\u0000'); }

// Load (or return) the doc for `file`. A clean doc is re-synced with the disk
// so external edits — a Claude session rewriting the file — show up on reopen.
// Resolves { doc } or { error } / { binary: true }.
export async function ensureDoc(file) {
  const existing = docs.get(file);
  const r = await readFromDisk(file);
  if (!r || !r.ok) return existing ? { doc: existing } : { error: (r && r.error) || 'could not read' };
  if (looksBinary(r.text)) return { binary: true };
  if (existing) {
    if (!existing.model.isDisposed()) {
      if (r.text !== existing.diskText) applyDiskText(existing, r.text);
      return { doc: existing };
    }
    docs.delete(file);
  }
  return { doc: createDoc(file, r.text) };
}

function createDoc(file, text) {
  const uri = monaco.Uri.file(absolutePathOf(file));
  const language = languageForFile(file, monaco.languages.getLanguages());
  const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, language, uri);
  if (model.getValue() !== text) model.setValue(text);
  const doc = {
    file,
    model,
    diskText: text,
    savedVersionId: model.getAlternativeVersionId(),
    readOnly: isAbsolutePath(file),
    conflict: false, // the disk changed while the buffer had unsaved edits
    viewState: null,
    wasDirty: false,
  };
  docs.set(file, doc);
  model.onDidChangeContent(() => {
    const dirty = isDirty(doc);
    if (dirty !== doc.wasDirty) { doc.wasDirty = dirty; emit(doc, 'dirty'); }
  });
  model.onWillDispose(() => {
    if (docs.get(file) === doc) docs.delete(file);
    emit(doc, 'disposed');
  });
  return doc;
}

// Replace the buffer with what's on disk as one undoable edit (so a reload can
// be undone) and mark it clean.
function applyDiskText(doc, text) {
  const { model } = doc;
  if (isDirty(doc)) {
    doc.conflict = true;
    doc.pendingDiskText = text;
    emit(doc, 'conflict');
    return;
  }
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  doc.diskText = text;
  doc.savedVersionId = model.getAlternativeVersionId();
  doc.conflict = false;
  doc.wasDirty = false;
  emit(doc, 'reloaded');
}

// The user chose "Reload" on a conflict: drop their edits for the disk version.
export function acceptDiskVersion(doc) {
  const text = doc.pendingDiskText ?? doc.diskText;
  doc.savedVersionId = doc.model.getAlternativeVersionId(); // so applyDiskText treats it as clean
  applyDiskText(doc, text);
}

// The user chose "Keep mine": their buffer stays and will overwrite on save.
export function keepBufferVersion(doc) {
  doc.diskText = doc.pendingDiskText ?? doc.diskText;
  doc.pendingDiskText = undefined;
  doc.conflict = false;
  emit(doc, 'dirty');
}

// Re-read the given files (repo-relative; null = every open doc) after a
// filesystem change and pull in external edits.
export async function syncFromDisk(paths) {
  const wanted = paths ? new Set(paths) : null;
  for (const doc of [...docs.values()]) {
    if (doc.readOnly || (wanted && !wanted.has(doc.file))) continue;
    const r = await readFromDisk(doc.file);
    if (!r || !r.ok || looksBinary(r.text) || doc.model.isDisposed()) continue;
    if (r.text !== doc.diskText) applyDiskText(doc, r.text);
  }
}

export async function saveDoc(doc) {
  if (!doc || doc.readOnly || doc.model.isDisposed()) return { ok: false };
  const text = doc.model.getValue();
  const versionAtSave = doc.model.getAlternativeVersionId();
  const r = await window.api.writeText(doc.file, text);
  if (!r || !r.ok) return { ok: false, error: r && r.error };
  doc.diskText = text;
  doc.savedVersionId = versionAtSave;
  doc.conflict = false;
  doc.wasDirty = isDirty(doc); // typing during the write keeps it dirty
  emit(doc, 'saved');
  return { ok: true };
}

// Close a doc's model (its tab closed and nothing else needs it).
export function disposeDoc(doc) {
  if (!doc.model.isDisposed()) doc.model.dispose();
  docs.delete(doc.file);
}

// A file renamed/moved in the explorer: carry its buffer (unsaved edits and
// all) over to a model at the new path.
export function renameDoc(oldFile, newFile) {
  const doc = docs.get(oldFile);
  if (!doc) return null;
  const value = doc.model.getValue();
  const dirty = isDirty(doc);
  const diskText = doc.diskText;
  disposeDoc(doc);
  const moved = createDoc(newFile, dirty ? diskText : value);
  if (dirty) moved.model.setValue(value);
  return moved;
}

// Language servers ask for files they reference (definitions, references, edits
// in other files). Load them as models without opening a tab.
export async function ensureModelForUri(uri) {
  const file = fileKeyForUri(uri);
  const r = await ensureDoc(file);
  return r.doc ? r.doc.model : null;
}
