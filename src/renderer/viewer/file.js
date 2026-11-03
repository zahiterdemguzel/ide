import { diffBody, diffView, showDiffContainer } from './code-render.js';
import { extOf, HTML_EXT, SCENE_EXT } from '../shared/ext.js';
import { jsonInsertion } from '../shared/json-edit.js';
import { fold } from '../shared/text-fold.js';
import { findTerminalLinks } from '../shared/terminal-links-parse.js';
import { openLink } from '../link-open.js';
import { t } from '../../i18n/index.js';
import { refreshGit } from '../git-pane.js';
import { showRunFor } from './run.js';
import { promptText } from '../shared/prompt.js';
import { openDialog } from '../shared/dialog.js';
import { getBreakpoints, saveBreakpoint, toggleBreakpoint, getExecLocation } from '../debug/state.js';
import { registerCommands } from '../command-palette.js';
import { loadMonaco, preloadMonacoWhenIdle } from '../editor/monaco-loader.js';
import { installEditorTheme } from '../editor/theme.js';
import { registerGdscript } from '../editor/gdscript-lang.js';
import { languageLabel } from '../editor/languages.js';
import {
  emptyTabs, openTab, pinTab, activateTab, closeTab, moveTab, renameTab, neighborTab, addBackgroundTab,
} from '../editor/tabs-model.js';
import { initTabs, renderTabs } from '../editor/tabs.js';
import {
  initDocuments, ensureDoc, getDoc, allDocs, isDirty, saveDoc, disposeDoc, renameDoc,
  onDocumentChange, setRepoRoot, getRepoRoot, absolutePathOf, fileKeyForUri, fileKeyForPath,
  ensureModelForUri, syncFromDisk, acceptDiskVersion, keepBufferVersion, docForModel, isAbsolutePath,
} from '../editor/documents.js';
import { initGutter, showGutterFor, onContentChanged, invalidateGitBaselines } from '../editor/gutter.js';
import { initStatusBar, updateStatusBar, showStatusBar } from '../editor/status-bar.js';
import { initBreadcrumbs, renderBreadcrumbs, setPlainTitle } from '../editor/breadcrumbs.js';
import { toggleProblems } from '../editor/problems.js';
import { openSymbolPicker, quickPick } from '../editor/symbol-picker.js';
import {
  EDITOR_DEFAULTS, loadSettings, saveSettings, normalizeSettings, toMonacoOptions, toModelOptions,
} from '../editor/editor-settings.js';

// The code editor: Monaco (VS Code's editor component) in the center pane's
// `#diff-view` container, with VS Code-style tabs, breadcrumbs, a status bar,
// git change markers + inline blame, debugger breakpoints, language-server
// intelligence (editor/lsp-client.js) and AI assistance (editor/ai.js).
//
// Buffers live in Monaco models (editor/documents.js) until saved — switching
// tabs, files or sessions never writes to disk and never loses an edit.
//
// The diff viewer shares #diff-body and clears it with innerHTML, which only
// detaches our host element; the element and the Monaco instance survive and
// are re-attached the next time a file is shown.

const saveBtn = document.getElementById('diff-save');
const previewToggle = document.getElementById('diff-preview'); // the Code | Preview segmented switch
const segCode = previewToggle.querySelector('[data-mode="code"]');
const segPreview = previewToggle.querySelector('[data-mode="preview"]');
const jsonBar = document.getElementById('editor-json-actions');
const jsonAddItemBtn = document.getElementById('json-add-item');
const jsonAddKeyBtn = document.getElementById('json-add-key');
const conflictBar = document.getElementById('editor-conflict');
const tabStrip = document.getElementById('editor-tabs');

const MAX_FILE_CHARS = 50 * 1024 * 1024;
const MAX_LINK_SCAN_LINES = 5000;
const CLOSED_HISTORY = 30;

let monaco = null;
let editor = null;
let editorReady = null;     // the in-flight ensureEditor() promise
let hostEl = null;          // the element Monaco renders into (kept across detaches)
let activeDoc = null;       // the doc in the editor, or null when a notice/nothing is shown
let tabs = emptyTabs();
let settings = loadSettings(localStorage);
let previewEl = null;       // Preview (webview / markdown div) while previewing; doubles as the flag
let showToken = 0;          // invalidates a showFile superseded by a newer one
let lsp = null;             // editor/lsp-client.js once loaded (optional)
let ai = null;              // editor/ai.js once loaded (optional)
const lspStates = new Map(); // languageId -> { state, name, message }
const closedFiles = [];      // recently closed files, for Reopen Closed Editor
const flash = { decos: null, timer: null };
let autoSaveTimer = null;

// The file most recently opened in the editor — backs the run toolbar's
// ${file}-family variable substitution (VS Code's "active editor" context).
let activeFile = null;
export function getActiveFile() { return activeFile; }

// The active editor's caret and selection, for the run toolbar's ${lineNumber} /
// ${columnNumber} / ${selectedText} variables. Both numbers are 1-based, as VS
// Code reports them.
export function getEditorContext() {
  const ctx = { activeFile };
  if (!editor || !activeDoc || previewEl) return ctx;
  const pos = editor.getPosition();
  const sel = editor.getSelection();
  if (pos) { ctx.lineNumber = pos.lineNumber; ctx.columnNumber = pos.column; }
  ctx.selectedText = sel ? activeDoc.model.getValueInRange(sel) : '';
  return ctx;
}

export function getEditorSettings() { return { ...settings }; }

export function setEditorSettings(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  saveSettings(localStorage, settings);
  if (editor) {
    editor.updateOptions(toMonacoOptions(settings));
    for (const doc of allDocs()) applyIndentation(doc);
  }
  refreshStatus();
}

// ── Monaco bootstrap ────────────────────────────────────────────────────────

function ensureEditor() {
  if (!editorReady) editorReady = createEditor().catch((e) => { editorReady = null; throw e; });
  return editorReady;
}

async function createEditor() {
  monaco = await loadMonaco();
  registerGdscript(monaco);
  initDocuments(monaco);
  const theme = installEditorTheme(monaco);
  quietBuiltinTypeScript();

  hostEl = document.createElement('div');
  hostEl.className = 'monaco-host';
  editor = monaco.editor.create(hostEl, {
    model: null,
    theme,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    glyphMargin: true,
    // Textarea input rather than the EditContext API: the app's global
    // shortcut guards recognise a focused TEXTAREA as "typing".
    editContext: false,
    renderLineHighlight: 'all',
    padding: { top: 6, bottom: 6 },
    mouseWheelZoom: true,
    linkedEditing: true,
    colorDecorators: true,
    showFoldingControls: 'mouseover',
    inlayHints: { enabled: 'onUnlessPressed' },
    'semanticHighlighting.enabled': true,
    suggest: { preview: true, showStatusBar: true },
    quickSuggestions: { other: 'on', comments: 'off', strings: 'on' },
    parameterHints: { enabled: true, cycle: true },
    hover: { delay: 350, sticky: true },
    lightbulb: { enabled: 'onCode' },
    stickyTabStops: true,
    unicodeHighlight: { ambiguousCharacters: false },
    ...toMonacoOptions(settings),
  });

  initGutter(monaco, editor, { editBreakpoint, settings: () => settings });
  wireEditorEvents();
  registerOpeners();
  registerLinkProvider();
  registerDebugHover();
  addEditorKeybindings();
  // The LSP client must be initialised before the first JS/TS model exists:
  // Monaco wires its built-in TS worker's providers on first use of the
  // language, and the client switches those off up front.
  await loadLanguageServers();
  loadAiFeatures();
  return editor;
}

// Monaco's built-in TS/JS worker can't see the project (no tsconfig, no
// node_modules), so its semantic errors are mostly false "cannot find module"
// noise. Keep its syntax checks; the language server supplies the real ones.
function quietBuiltinTypeScript() {
  const ts = monaco.typescript || (monaco.languages && monaco.languages.typescript);
  if (!ts) return;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    if (!defaults) continue;
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      allowNonTsExtensions: true,
      allowJs: true,
      jsx: ts.JsxEmit ? ts.JsxEmit.ReactJSX : undefined,
      target: ts.ScriptTarget ? ts.ScriptTarget.ESNext : undefined,
    });
  }
}

// The language-server client and the AI features are separate modules; the
// editor works without either (each loads lazily and failures are logged).
async function loadLanguageServers() {
  try {
    lsp = await import('../editor/lsp-client.js');
    lsp.initLsp(monaco, {
      getRoot: () => getRepoRoot(),
      ensureModel: (uri) => ensureModelForUri(uri).then((model) => { if (model) trackWithLsp(docForModel(model)); return model; }),
      onStatus: (languageId, status) => { lspStates.set(languageId, status); refreshStatus(); },
    });
    lsp.onDiagnosticsChanged(() => { invalidateProblemCounts(); refreshStatus(); });
  } catch (e) { lsp = null; console.error('[editor] language servers unavailable:', e); }
}

async function loadAiFeatures() {
  try {
    ai = await import('../editor/ai.js');
    ai.initAi(monaco, {
      getRepoPath: () => getRepoRoot(),
      relPath: (model) => { const doc = docForModel(model); return doc ? doc.file : fileKeyForUri(model.uri); },
      isInlineEnabled: () => settings.inlineCompletions,
      sendToSession: (text) => import('../sessions.js').then((m) => m.sendToActiveSession(text)),
      askInNewSession: (text) => import('../sessions.js').then((m) => m.newSessionWithPrompt(text)),
    });
    ai.attachAiToEditor(editor);
    ai.onAiStatus(() => refreshStatus());
  } catch (e) { ai = null; console.error('[editor] AI features unavailable:', e); }
  refreshStatus();
}

function trackWithLsp(doc) {
  if (!lsp || !doc || doc.lspTracked) return;
  doc.lspTracked = true;
  try { lsp.lspTrackModel(doc.model); } catch (e) { console.error('[lsp] track failed:', e); }
}

// ── Showing files ───────────────────────────────────────────────────────────

// Open `file` (repo-relative, or absolute for files outside the repo) in a tab.
// `jump` (optional { line, term, column }) reveals a line and flashes the term.
// `preview` opens a preview tab that the next preview open replaces (VS Code's
// single-click behaviour); editing or double-clicking the tab pins it.
export async function showFile(file, jump, { preview = true } = {}) {
  activeFile = file;
  const token = ++showToken;
  showDiffContainer();
  if (!editor) showNotice(t('editor.loading'));
  try { await ensureEditor(); } catch (e) {
    console.error('[editor] Monaco failed to load:', e);
    showNotice(t('editor.loadFailed'));
    return;
  }
  await syncRepoRoot();
  if (token !== showToken) return;
  const r = await ensureDoc(file);
  if (token !== showToken) return;
  if (r.binary) { showNotice(t('editor.binary')); return; }
  if (r.error) { showNotice(r.error); return; }
  if (r.doc.model.getValueLength() > MAX_FILE_CHARS) {
    // Never shown, so nothing else would ever free its model and disk copy.
    if (!tabs.tabs.some((tab) => tab.file === file) && !isDirty(r.doc)) disposeDoc(r.doc);
    showNotice(t('editor.tooLarge'));
    return;
  }

  const before = tabs;
  tabs = openTab(tabs, file, { preview: preview && !isDirty(r.doc) });
  disposeDroppedDocs(before, tabs);
  mountDoc(r.doc);
  if (jump) requestAnimationFrame(() => jumpTo(jump));
}

// A preview open replaces the previous preview tab; its (clean) buffer goes too.
function disposeDroppedDocs(before, after) {
  for (const tab of before.tabs) {
    if (after.tabs.some((t) => t.file === tab.file)) continue;
    const doc = getDoc(tab.file);
    if (doc && !isDirty(doc)) disposeDoc(doc);
  }
}

function attachHost() {
  if (hostEl.parentElement !== diffBody) diffBody.replaceChildren(hostEl);
  else for (const el of [...diffBody.children]) if (el !== hostEl) el.remove();
  diffBody.classList.add('has-editor');
}

function mountDoc(doc) {
  exitPreviewDom();
  if (activeDoc && activeDoc !== doc && !activeDoc.model.isDisposed()) activeDoc.viewState = editor.saveViewState();
  activeDoc = doc;
  activeFile = doc.file;
  attachHost();
  hookDoc(doc);
  if (editor.getModel() !== doc.model) {
    editor.setModel(doc.model);
    if (doc.viewState) editor.restoreViewState(doc.viewState);
  }
  editor.updateOptions({ readOnly: doc.readOnly });
  showGutterFor(doc);
  trackWithLsp(doc);
  renderTabs(tabs);
  showStatusBar(true);
  saveBtn.hidden = doc.readOnly;
  const ext = extOf(doc.file);
  previewToggle.hidden = !(HTML_EXT.has(ext) || SCENE_EXT.has(ext) || isMarkdown(doc.file));
  if (!previewToggle.hidden) syncToggle();
  showConflict(doc);
  updateDirtyUi();
  syncJsonBar();
  refreshStatus();
  showRunFor(isAbsolutePath(doc.file) ? '' : doc.file);
  disposeUntabbedDocs();
  requestAnimationFrame(() => { editor.layout(); editor.focus(); });
}

// Models loaded only for language-server navigation (Cmd+hover, peek, Find
// References across hundreds of files) never get a tab, so closing tabs never
// frees them. Once the user is on another file, drop every clean doc with no tab;
// a rename's unsaved background edits are dirty and stay.
function disposeUntabbedDocs() {
  for (const doc of allDocs()) {
    if (doc === activeDoc || isDirty(doc) || tabs.tabs.some((tab) => tab.file === doc.file)) continue;
    disposeDoc(doc);
  }
}

function isMarkdown(file) { const ext = extOf(file); return ext === 'md' || ext === 'markdown'; }

// With "detect indentation" on, each file keeps the indentation it was written
// with (VS Code's default); otherwise the configured tab size / spaces apply.
function applyIndentation(doc) {
  if (settings.detectIndentation) doc.model.detectIndentation(settings.insertSpaces, settings.tabSize);
  else doc.model.updateOptions(toModelOptions(settings));
}

// One-time per-doc wiring: the listeners that pin a preview tab on edit,
// repaint the gutter, schedule auto-save and keep the JSON bar current.
function hookDoc(doc) {
  if (doc.hooked) return;
  doc.hooked = true;
  applyIndentation(doc);
  doc.model.onDidChangeContent(() => {
    if (isDirty(doc) && tabs.tabs.some((tab) => tab.file === doc.file && tab.preview)) {
      tabs = pinTab(tabs, doc.file);
      renderTabs(tabs);
    }
    onContentChanged(doc);
    // The JSON bar is not synced here: every edit also moves the cursor, and the
    // cursor handler already re-syncs it once per frame (it scans the whole buffer).
    scheduleAutoSave(doc);
  });
}

function showNotice(msg) {
  if (activeDoc && editor && !activeDoc.model.isDisposed()) activeDoc.viewState = editor.saveViewState();
  activeDoc = null;
  exitPreviewDom();
  saveBtn.hidden = true;
  previewToggle.hidden = true;
  jsonBar.hidden = true;
  conflictBar.hidden = true;
  showStatusBar(false);
  renderTabs(tabs);
  if (activeFile) setPlainTitle(activeFile);
  diffBody.classList.remove('has-editor');
  const el = document.createElement('div');
  el.className = 'editor-notice';
  el.textContent = msg;
  diffBody.replaceChildren(el);
}

// ── Repo root ───────────────────────────────────────────────────────────────

// Model URIs and language servers are rooted at the open folder. When the user
// switches folders, files from the old one can't stay keyed by relative path
// (a save would land in the new folder), so their tabs close — after offering
// to save any unsaved edits to their original location.
// `knownRoot` (from a folder-changed event) is applied synchronously, so the
// language-server client sees the new root when it re-checks on the next tick.
async function syncRepoRoot(knownRoot) {
  const root = knownRoot !== undefined ? knownRoot : await window.api.getRepoPath();
  const old = getRepoRoot();
  if (root === old) return;
  setRepoRoot(root);
  invalidateGitBaselines();
  if (old) await closeDocsFromRoot(old);
}

export async function onEditorRepoChanged(root) { if (editor) await syncRepoRoot(root); }

async function closeDocsFromRoot(oldRoot) {
  const dirty = allDocs().filter((doc) => isDirty(doc) && !doc.readOnly);
  if (dirty.length) {
    const save = await openDialog({
      title: t('editor.folderSwitchTitle'),
      body: t('editor.folderSwitchBody').replace('{n}', dirty.length),
      cancelValue: false,
      buttons: [
        { label: t('editor.dontSave'), value: false, variant: 'secondary' },
        { label: t('editor.saveAll'), value: true, variant: 'primary' },
      ],
    });
    if (save) {
      for (const doc of dirty) await window.api.writeTextAbs(`${oldRoot}/${doc.file}`, doc.model.getValue());
    }
  }
  for (const doc of allDocs()) disposeDoc(doc);
  tabs = emptyTabs();
  activeDoc = null;
  if (editor) editor.setModel(null);
  renderTabs(tabs);
}

// ── Tabs ────────────────────────────────────────────────────────────────────

initTabs({
  activate: (file) => activateFile(file),
  pin: (file) => { tabs = pinTab(tabs, file); renderTabs(tabs); },
  close: (file) => closeFile(file),
  closeMany: (files) => closeFiles(files),
  move: (file, index) => { tabs = moveTab(tabs, file, index); renderTabs(tabs); },
  isDirty: (file) => isDirty(getDoc(file)),
  reveal: (file) => revealInExplorer(file),
  copyPath: (file) => window.api.clipboardWrite(absolutePathOf(file)),
});

function revealInExplorer(file) {
  if (!isAbsolutePath(file)) import('../explorer/tree.js').then((m) => m.revealInTree(file));
}

async function activateFile(file) {
  const doc = getDoc(file);
  if (!doc) { await showFile(file, null, { preview: false }); return; }
  tabs = activateTab(tabs, file);
  mountDoc(doc);
}

// Close a tab, asking first when it has unsaved edits. Resolves false if the
// user cancelled.
export async function closeFile(file) {
  const doc = getDoc(file);
  if (doc && isDirty(doc)) {
    const choice = await openDialog({
      title: t('editor.unsavedTitle'),
      body: t('editor.unsavedBody').replace('{file}', file),
      cancelValue: 'cancel',
      buttons: [
        { label: t('editor.cancel'), value: 'cancel', variant: 'secondary' },
        { label: t('editor.dontSave'), value: 'discard', variant: 'secondary' },
        { label: t('editor.save'), value: 'save', variant: 'primary' },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDocWithHooks(doc)).ok) return false;
  }
  const wasActive = tabs.active === file;
  tabs = closeTab(tabs, file);
  closedFiles.push(file);
  if (closedFiles.length > CLOSED_HISTORY) closedFiles.shift();
  if (doc) {
    if (doc === activeDoc) activeDoc = null;
    disposeDoc(doc);
  }
  if (!tabs.tabs.length) {
    renderTabs(tabs);
    if (editor) editor.setModel(null);
    const { closeOverlay } = await import('./center.js');
    closeOverlay();
    return true;
  }
  if (wasActive) await activateFile(tabs.active);
  else renderTabs(tabs);
  return true;
}

async function closeFiles(files) {
  for (const file of files) { if (!(await closeFile(file))) return; }
}

// A file or folder was renamed/moved in the explorer: tabs and buffers
// (unsaved edits included) follow it.
export function renameOpenFile(oldPath, newPath) {
  const prefix = `${oldPath}/`;
  for (const doc of allDocs()) {
    if (doc.file !== oldPath && !doc.file.startsWith(prefix)) continue;
    const oldFile = doc.file;
    const newFile = newPath + oldFile.slice(oldPath.length);
    const wasActive = activeDoc === doc;
    if (wasActive) activeDoc = null;
    const moved = renameDoc(oldFile, newFile);
    tabs = renameTab(tabs, oldFile, newFile);
    if (wasActive && moved) mountDoc(moved);
  }
  renderTabs(tabs);
}

function reopenClosed() {
  const file = closedFiles.pop();
  if (file) showFile(file, null, { preview: false });
}

// ── Saving ──────────────────────────────────────────────────────────────────

function updateDirtyUi() {
  if (!activeDoc) return;
  const dirty = isDirty(activeDoc);
  saveBtn.disabled = !dirty;
  saveBtn.classList.toggle('dirty', dirty);
  renderBreadcrumbs(activeDoc.file, activeDoc.model, editor.getPosition(), { dirty });
}

async function saveDocWithHooks(doc) {
  if (settings.formatOnSave && doc === activeDoc && editor.getModel() === doc.model) {
    const format = editor.getAction('editor.action.formatDocument');
    try { if (format && format.isSupported()) await format.run(); } catch { /* no formatter for this language */ }
  }
  const r = await saveDoc(doc);
  if (!r.ok) { console.error('save failed:', r.error); return r; }
  if (lsp && lsp.lspNotifySaved) lsp.lspNotifySaved(doc.model);
  refreshGit(); // surface the new diff in the git pane immediately
  return r;
}

export async function saveActiveFile() {
  if (!activeDoc || !isDirty(activeDoc)) return;
  await saveDocWithHooks(activeDoc);
}

export async function saveAllFiles() {
  for (const doc of allDocs()) if (isDirty(doc) && !doc.readOnly) await saveDocWithHooks(doc);
}

function scheduleAutoSave(doc) {
  if (settings.autoSave !== 'afterDelay' || doc.readOnly) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { if (isDirty(doc)) saveDocWithHooks(doc); }, settings.autoSaveDelay);
}

onDocumentChange((doc, reason) => {
  if (reason === 'disposed') return;
  if (isDirty(doc) && !tabs.tabs.some((tab) => tab.file === doc.file)) tabs = addBackgroundTab(tabs, doc.file);
  renderTabs(tabs);
  if (doc !== activeDoc) return;
  updateDirtyUi();
  showConflict(doc);
  if (reason === 'reloaded') onContentChanged(doc);
});

// External edits (a Claude session rewriting an open file, a git checkout):
// clean buffers reload in place; dirty ones get the conflict bar.
window.api.onTreeChanged((paths) => {
  if (!editor) return;
  syncFromDisk(paths);
  invalidateGitBaselines();
});

// ── Disk conflict bar ───────────────────────────────────────────────────────

function showConflict(doc) {
  conflictBar.hidden = !(doc && doc.conflict);
  refreshStatus();
}
document.getElementById('editor-conflict-reload').onclick = () => { if (activeDoc) acceptDiskVersion(activeDoc); showConflict(activeDoc); };
document.getElementById('editor-conflict-keep').onclick = () => { if (activeDoc) keepBufferVersion(activeDoc); showConflict(activeDoc); };
document.getElementById('editor-conflict-compare').onclick = () => { if (activeDoc) openCompare(activeDoc); };

// Side-by-side diff of the disk version (left) against the buffer (right),
// which stays editable so the user can merge by hand before saving.
function openCompare(doc) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop compare-backdrop';
  const box = document.createElement('div');
  box.className = 'compare-box';
  const head = document.createElement('div');
  head.className = 'compare-head';
  const title = document.createElement('span');
  title.textContent = t('editor.compareTitle').replace('{file}', doc.file);
  const close = document.createElement('button');
  close.className = 'compare-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('editor.tabClose'));
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'compare-body';
  box.append(head, body);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  const original = monaco.editor.createModel(doc.pendingDiskText ?? doc.diskText, doc.model.getLanguageId());
  const diff = monaco.editor.createDiffEditor(body, { automaticLayout: true, originalEditable: false, renderSideBySide: true });
  diff.setModel({ original, modified: doc.model });
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dispose(); } };
  function dispose() {
    window.removeEventListener('keydown', onKey, true);
    diff.dispose();
    original.dispose();
    backdrop.remove();
  }
  close.onclick = dispose;
  backdrop.onclick = (e) => { if (e.target === backdrop) dispose(); };
  window.addEventListener('keydown', onKey, true);
}

// ── Editor events, openers, links ───────────────────────────────────────────

function wireEditorEvents() {
  // Cursor moves fire per keystroke/drag step; coalesce them to one update per frame.
  let cursorFrame = 0;
  editor.onDidChangeCursorSelection(() => {
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      if (!activeDoc || activeDoc.model.isDisposed()) return;
      refreshStatus();
      syncJsonBar();
      renderBreadcrumbs(activeDoc.file, activeDoc.model, editor.getPosition(), { dirty: isDirty(activeDoc) });
    });
  });
  editor.onDidChangeModelLanguage(() => refreshStatus());
  editor.onDidChangeModelOptions(() => refreshStatus());
  editor.onDidBlurEditorWidget(() => {
    if (settings.autoSave === 'onFocusChange' && activeDoc && isDirty(activeDoc)) saveDocWithHooks(activeDoc);
  });
  window.addEventListener('blur', () => { if (settings.autoSave === 'onFocusChange') saveAllFiles(); });
  // Fires once per file per marker owner — a diagnostics burst across a workspace is
  // hundreds of events, each rebuilding every problem count. One update per frame.
  let markersFrame = 0;
  monaco.editor.onDidChangeMarkers(() => {
    if (markersFrame) return;
    markersFrame = requestAnimationFrame(() => { markersFrame = 0; invalidateProblemCounts(); refreshStatus(); });
  });
}

// Go to Definition / Peek / Find References into another file opens it in a tab.
function registerOpeners() {
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      openUri(resource, selectionOrPosition);
      return true;
    },
  });
  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme === 'ide-link') {
        const q = new URLSearchParams(resource.query);
        openLink(q.get('kind'), q.get('raw'), baseDirOf(activeDoc));
        return true;
      }
      if (resource.scheme === 'http' || resource.scheme === 'https') { openLink('url', resource.toString(true)); return true; }
      if (resource.scheme === 'file') { openUri(resource, null); return true; }
      return false;
    },
  });
}

async function openUri(uri, selectionOrPosition) {
  const file = fileKeyForUri(uri);
  await showFile(file, null, { preview: true });
  if (!selectionOrPosition || !activeDoc || activeDoc.file !== file) return;
  if ('startLineNumber' in selectionOrPosition) {
    editor.setSelection(selectionOrPosition);
    editor.revealRangeInCenterIfOutsideViewport(selectionOrPosition);
  } else {
    editor.setPosition(selectionOrPosition);
    editor.revealPositionInCenterIfOutsideViewport(selectionOrPosition);
  }
}

// Absolute folder a file's relative links resolve against.
function baseDirOf(doc) {
  if (!doc) return getRepoRoot();
  const abs = absolutePathOf(doc.file);
  return abs.slice(0, Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')));
}

// File paths in the code are Ctrl/Cmd+clickable (VS Code's gesture), detected
// by the same pure helper the terminal uses. Monaco finds URLs itself.
function registerLinkProvider() {
  monaco.languages.registerLinkProvider('*', {
    provideLinks(model) {
      const links = [];
      const lines = Math.min(model.getLineCount(), MAX_LINK_SCAN_LINES);
      for (let ln = 1; ln <= lines; ln++) {
        const text = model.getLineContent(ln);
        if (text.length > 2000) continue;
        for (const link of findTerminalLinks(text)) {
          if (link.kind === 'url') continue;
          links.push({
            range: new monaco.Range(ln, link.start + 1, ln, link.end + 1),
            url: `ide-link:/open?${new URLSearchParams({ kind: link.kind, raw: link.raw })}`,
            tooltip: t('editor.followLink'),
          });
        }
      }
      return { links };
    },
  });
}

// While the debugger is paused, hovering an identifier shows its value.
function registerDebugHover() {
  monaco.languages.registerHoverProvider('*', {
    async provideHover(model, position) {
      if (!getExecLocation()) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // Extend left over member access so `self.player.hp` evaluates as a whole.
      const line = model.getLineContent(position.lineNumber);
      let start = word.startColumn - 1;
      while (start > 0 && /[\w.]/.test(line[start - 1])) start--;
      const expression = line.slice(start, word.endColumn - 1).replace(/^\.+/, '');
      const { evaluateForHover } = await import('../debug/panel.js');
      const r = await evaluateForHover(expression);
      if (!r) return null;
      return {
        range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn),
        contents: [
          { value: `\`${expression}\`${r.type ? ` · *${r.type}*` : ''}` },
          { value: '```\n' + r.result + '\n```' },
        ],
      };
    },
  });
}

// ── Editor-scoped keybindings ───────────────────────────────────────────────

function addEditorKeybindings() {
  const { KeyMod, KeyCode } = monaco;
  editor.addCommand(KeyCode.F9, () => {
    const pos = editor.getPosition();
    if (activeDoc && pos) toggleBreakpoint(activeDoc.file, pos.lineNumber);
  });
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () => zoom(1));
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () => zoom(-1));
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.Digit0, () => setEditorSettings({ fontSize: EDITOR_DEFAULTS.fontSize }));
  editor.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => setEditorSettings({ wordWrap: !settings.wordWrap }));
  // Clipboard through main's retrying clipboard handlers: the renderer's async
  // Clipboard API is unreliable under file://, and there's no app Edit menu on
  // macOS to supply the native roles.
  // Scoped to the text area so the find/replace inputs keep their own clipboard.
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyC, () => copySelection(false), 'editorTextFocus');
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyX, () => copySelection(true), 'editorTextFocus');
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyV, async () => {
    const text = await window.api.clipboardRead();
    if (typeof text === 'string' && text) editor.trigger('keyboard', 'paste', { text });
  }, 'editorTextFocus');
}

function zoom(dir) { setEditorSettings({ fontSize: settings.fontSize + dir }); }

// Copy (or cut) like VS Code: selections joined by newlines; with nothing
// selected, the whole caret line(s) including the line break.
function copySelection(cut) {
  const model = editor.getModel();
  if (!model) return;
  const selections = editor.getSelections() || [];
  const eol = model.getEOL();
  let text;
  let ranges;
  if (selections.every((s) => s.isEmpty())) {
    const lines = [...new Set(selections.map((s) => s.positionLineNumber))].sort((a, b) => a - b);
    text = lines.map((ln) => model.getLineContent(ln) + eol).join('');
    ranges = lines.map((ln) => wholeLineRange(model, ln));
  } else {
    text = selections.map((s) => model.getValueInRange(s)).join(eol);
    ranges = selections;
  }
  window.api.clipboardWrite(text);
  if (!cut || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  editor.pushUndoStop();
  editor.executeEdits('cut', ranges.map((range) => ({ range, text: '' })));
  editor.pushUndoStop();
}

// The range that deletes line `ln` and one adjacent line break.
function wholeLineRange(model, ln) {
  if (ln < model.getLineCount()) return new monaco.Range(ln, 1, ln + 1, 1);
  if (ln === 1) return new monaco.Range(1, 1, 1, model.getLineMaxColumn(1));
  return new monaco.Range(ln - 1, model.getLineMaxColumn(ln - 1), ln, model.getLineMaxColumn(ln));
}

function runEditorAction(id) {
  if (!editor || !activeDoc) return;
  editor.focus();
  const action = editor.getAction(id);
  if (action) action.run(); else editor.trigger('palette', id, null);
}

function workspaceSymbols() {
  if (!lsp || !lsp.lspWorkspaceSymbols) return;
  const model = activeDoc && editor.getModel();
  const word = model && editor.getPosition() ? (model.getWordAtPosition(editor.getPosition()) || {}).word : '';
  openSymbolPicker({
    search: (query) => lsp.lspWorkspaceSymbols(query, activeDoc ? activeDoc.model.getLanguageId() : undefined),
    open: (item) => openUri(monaco.Uri.parse(item.uri), item.range),
  }, word || '');
}

registerCommands([
  { id: 'editor-save-all', titleKey: 'command.editorSaveAll', run: saveAllFiles },
  { id: 'editor-format', titleKey: 'command.editorFormat', run: () => runEditorAction('editor.action.formatDocument') },
  { id: 'editor-goto-line', titleKey: 'command.editorGotoLine', run: () => runEditorAction('editor.action.gotoLine') },
  { id: 'editor-goto-symbol', titleKey: 'command.editorGotoSymbol', run: () => runEditorAction('editor.action.quickOutline') },
  { id: 'editor-workspace-symbol', titleKey: 'command.editorWorkspaceSymbol', run: workspaceSymbols },
  { id: 'editor-rename', titleKey: 'command.editorRename', run: () => runEditorAction('editor.action.rename') },
  { id: 'editor-references', titleKey: 'command.editorReferences', run: () => runEditorAction('editor.action.referenceSearch.trigger') },
  { id: 'editor-quick-fix', titleKey: 'command.editorQuickFix', run: () => runEditorAction('editor.action.quickFix') },
  { id: 'editor-commands', titleKey: 'command.editorCommands', run: () => runEditorAction('editor.action.quickCommand') },
  { id: 'editor-word-wrap', titleKey: 'command.editorWordWrap', run: () => setEditorSettings({ wordWrap: !settings.wordWrap }) },
  { id: 'editor-minimap', titleKey: 'command.editorMinimap', run: () => setEditorSettings({ minimap: !settings.minimap }) },
  { id: 'editor-blame', titleKey: 'command.editorBlame', run: () => setEditorSettings({ inlineBlame: !settings.inlineBlame }) },
  { id: 'editor-ai-inline', titleKey: 'command.editorAiInline', run: () => setEditorSettings({ inlineCompletions: !settings.inlineCompletions }) },
  { id: 'editor-language', titleKey: 'command.editorLanguage', run: pickLanguage },
  { id: 'editor-reopen', titleKey: 'command.editorReopen', run: reopenClosed },
  { id: 'editor-close-all', titleKey: 'command.editorCloseAll', run: () => closeFiles(tabs.tabs.map((tab) => tab.file)) },
  { id: 'editor-restart-lsp', titleKey: 'command.editorRestartLsp', run: restartLsp },
]);

// App-level shortcuts for the editor while its tabs are showing. Capture phase
// so they work whichever pane holds focus; Monaco's own bindings do the rest.
// The visible tab strip is the "editor view is up" signal: hideDiff() hides it
// for diffs, commits and asset views.
document.addEventListener('keydown', (e) => {
  const editorUp = !tabStrip.hidden && diffView.style.display !== 'none';
  if (!editorUp) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.shiftKey && key === 's') {
    e.preventDefault();
    if (e.altKey) saveAllFiles(); else saveActiveFile();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && key === 'w') { e.preventDefault(); if (tabs.active) closeFile(tabs.active); return; }
  if (mod && e.shiftKey && key === 't') { e.preventDefault(); reopenClosed(); return; }
  if (mod && !e.shiftKey && !e.altKey && key === 't') { e.preventDefault(); workspaceSymbols(); return; }
  const next = (e.ctrlKey && e.key === 'PageDown') || (e.metaKey && e.altKey && e.key === 'ArrowRight');
  const prev = (e.ctrlKey && e.key === 'PageUp') || (e.metaKey && e.altKey && e.key === 'ArrowLeft');
  if (next || prev) {
    e.preventDefault();
    const target = neighborTab(tabs, next ? 1 : -1);
    if (target) activateFile(target);
  }
}, true);

saveBtn.onclick = saveActiveFile;

// ── Status bar & breadcrumbs ────────────────────────────────────────────────

initStatusBar({
  problems: (_e, btn) => toggleProblems(btn, problemGroups(), (file, line, column) => showFile(file, { line, column })),
  position: () => runEditorAction('editor.action.gotoLine'),
  indent: pickIndentation,
  eol: toggleLineEndings,
  language: pickLanguage,
  lsp: restartLsp,
  ai: () => setEditorSettings({ inlineCompletions: !settings.inlineCompletions }),
});

initBreadcrumbs({
  getSymbols: (model) => (lsp && lsp.lspDocumentSymbols ? lsp.lspDocumentSymbols(model) : Promise.resolve(null)),
  revealRange: (range) => {
    editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
    editor.revealRangeInCenterIfOutsideViewport(range);
    editor.focus();
  },
  revealFolder: revealInExplorer,
  currentPosition: () => (editor ? editor.getPosition() : null),
  isDirty: () => isDirty(activeDoc),
});

const LSP_TO_MARKER_SEVERITY = { 1: 8, 2: 4, 3: 2, 4: 1 };
const MARKER_ERROR = 8;
const MARKER_WARNING = 4;

// Problems across files: the language servers' diagnostics (every file they
// report on, open or not) plus Monaco's built-in workers' markers (JSON, CSS,
// HTML) for files no server covers.
function problemGroups() {
  const groups = [];
  if (lsp && lsp.getAllDiagnostics) {
    for (const g of lsp.getAllDiagnostics()) {
      groups.push({
        file: g.path ? fileKeyForPath(g.path) : g.uri,
        items: g.diagnostics.map((d) => ({
          severity: LSP_TO_MARKER_SEVERITY[d.severity] || 2,
          message: d.message,
          source: d.source,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
        })),
      });
    }
  }
  const covered = new Set(groups.map((g) => g.file));
  return [...groups, ...markerGroups().filter((g) => !covered.has(g.file))].filter((g) => g.items.length);
}

function markerGroups() {
  if (!monaco) return [];
  const byFile = new Map();
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.owner && m.owner.startsWith('lsp')) continue; // already in the server's diagnostics
    const file = fileKeyForUri(m.resource);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ severity: m.severity, message: m.message, source: m.source, line: m.startLineNumber, column: m.startColumn });
  }
  return [...byFile].map(([file, items]) => ({ file, items }));
}

// Error/warning totals only change with diagnostics/markers, so the status bar
// reuses them across cursor moves instead of re-walking every problem.
let problemCounts = null;

function invalidateProblemCounts() {
  problemCounts = null;
}

function countProblems() {
  if (problemCounts) return problemCounts;
  let errors = 0;
  let warnings = 0;
  for (const g of problemGroups()) {
    for (const item of g.items) {
      if (item.severity === MARKER_ERROR) errors++;
      else if (item.severity === MARKER_WARNING) warnings++;
    }
  }
  problemCounts = { errors, warnings };
  return problemCounts;
}

function refreshStatus() {
  if (!editor || !activeDoc || activeDoc.model.isDisposed()) return;
  const model = activeDoc.model;
  const pos = editor.getPosition() || { lineNumber: 1, column: 1 };
  const selections = editor.getSelections() || [];
  const opts = model.getOptions();
  const { errors, warnings } = countProblems();
  const languageId = model.getLanguageId();
  const aiState = ai && ai.aiStatus ? ai.aiStatus() : { available: false, busy: false };
  updateStatusBar({
    line: pos.lineNumber,
    column: pos.column,
    selected: selections.reduce((n, s) => n + model.getValueLengthInRange(s), 0),
    selections: selections.length,
    tabSize: opts.tabSize,
    insertSpaces: opts.insertSpaces,
    eol: model.getEOL() === '\n' ? 'LF' : 'CRLF',
    languageLabel: languageLabel(languageId, monaco.languages.getLanguages()),
    errors,
    warnings,
    lsp: lspStates.get(languageId) || null,
    ai: { enabled: settings.inlineCompletions, available: !!(ai && aiState.available), busy: !!aiState.busy },
    conflict: !!activeDoc.conflict,
    readOnly: activeDoc.readOnly,
  });
}

function toggleLineEndings() {
  if (!activeDoc || activeDoc.readOnly) return;
  const { EndOfLineSequence } = monaco.editor;
  activeDoc.model.pushEOL(activeDoc.model.getEOL() === '\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
  refreshStatus();
}

function pickLanguage() {
  if (!activeDoc) return;
  const doc = activeDoc;
  const current = doc.model.getLanguageId();
  const items = monaco.languages.getLanguages()
    .map((l) => ({ name: (l.aliases && l.aliases[0]) || l.id, detail: l.id === current ? `${l.id} · ${t('editor.current')}` : l.id, value: l.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  quickPick(items, {
    placeholder: t('editor.pickLanguage'),
    onPick: (id) => { if (!doc.model.isDisposed()) monaco.editor.setModelLanguage(doc.model, id); },
  });
}

function pickIndentation() {
  if (!activeDoc || activeDoc.readOnly) return;
  const model = activeDoc.model;
  const items = [
    { name: t('editor.indentSpaces').replace('{n}', 2), value: () => model.updateOptions({ insertSpaces: true, tabSize: 2 }) },
    { name: t('editor.indentSpaces').replace('{n}', 4), value: () => model.updateOptions({ insertSpaces: true, tabSize: 4 }) },
    { name: t('editor.indentTabs'), value: () => model.updateOptions({ insertSpaces: false }) },
    { name: t('editor.indentToSpaces'), value: () => runEditorAction('editor.action.indentationToSpaces') },
    { name: t('editor.indentToTabs'), value: () => runEditorAction('editor.action.indentationToTabs') },
    { name: t('editor.indentDetect'), value: () => model.detectIndentation(settings.insertSpaces, settings.tabSize) },
  ];
  quickPick(items, {
    placeholder: t('editor.statusIndent'),
    onPick: (apply) => { if (!model.isDisposed()) { apply(); refreshStatus(); } },
  });
}

async function restartLsp() {
  if (!lsp || !lsp.lspRestart || !activeDoc) return;
  await lsp.lspRestart(activeDoc.model.getLanguageId());
}

// ── Breakpoint editing (right-click in the glyph margin) ────────────────────

// Prefixes pick the kind, as in VS Code's inline editor: "hits: 3",
// "log: x is {x}", anything else is a condition.
async function editBreakpoint(file, line) {
  const current = getBreakpoints(file).find((bp) => bp.line === line);
  let value = '';
  if (current) {
    if (current.logMessage) value = `log: ${current.logMessage}`;
    else if (current.hitCondition) value = `hits: ${current.hitCondition}`;
    else value = current.condition || '';
  }
  const answer = await promptText({
    title: t('editor.breakpointTitle').replace('{line}', line),
    label: t('editor.breakpointLabel'),
    value,
    ok: t('editor.save'),
  });
  if (answer == null) return;
  const text = answer.trim();
  const bp = { line, enabled: true };
  const log = /^log:\s*(.*)$/i.exec(text);
  const hits = /^hits:\s*(.*)$/i.exec(text);
  if (log) bp.logMessage = log[1];
  else if (hits) bp.hitCondition = hits[1];
  else if (text) bp.condition = text;
  saveBreakpoint(file, bp);
}

// ── Jumps (search results, Problems, debugger frames) ───────────────────────

// Reveal `line`, put a collapsed caret on `term` (or `column`) and flash it for
// two seconds — a highlight, not a selection, so the next keystroke can't
// overwrite it.
function jumpTo({ line, term, column }) {
  if (!editor || !activeDoc) return;
  const model = activeDoc.model;
  const ln = Math.min(Math.max(line || 1, 1), model.getLineCount());
  const lineText = model.getLineContent(ln);
  let start = column || 1;
  let end = start;
  if (term) {
    const hit = fold(lineText).indexOf(fold(term)); // fold is length-preserving, so hit indexes the raw line
    if (hit >= 0) { start = hit + 1; end = start + term.length; }
  }
  editor.setPosition({ lineNumber: ln, column: start });
  editor.revealLineInCenter(ln);
  const highlightTerm = end > start;
  if (!flash.decos) flash.decos = editor.createDecorationsCollection();
  flash.decos.set([{
    range: new monaco.Range(ln, highlightTerm ? start : 1, ln, highlightTerm ? end : 1),
    options: highlightTerm ? { inlineClassName: 'jump-flash' } : { isWholeLine: true, className: 'jump-flash-line' },
  }]);
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => flash.decos.clear(), 2000);
  editor.focus();
}

// ── Preview (HTML page / Markdown / Godot scene) ────────────────────────────

function syncToggle() {
  const previewing = !!previewEl;
  previewToggle.classList.toggle('previewing', previewing);
  previewToggle.setAttribute('aria-checked', String(previewing));
  segCode.classList.toggle('active', !previewing);
  segPreview.classList.toggle('active', previewing);
  const titleKey = previewing ? 'editor.codeTitle' : 'editor.previewTitle';
  previewToggle.dataset.i18nTitle = titleKey;
  previewToggle.title = t(titleKey);
}

async function enterPreview() {
  if (!activeDoc || previewEl) return;
  const doc = activeDoc;
  // Godot scenes: "Preview" is the 3D scene editor, a different center view.
  if (SCENE_EXT.has(extOf(doc.file))) {
    await saveActiveFile();
    const { openFromTree } = await import('./center.js');
    openFromTree(doc.file);
    return;
  }
  const el = isMarkdown(doc.file) ? await markdownPreview(doc) : await htmlPreview(doc);
  // A view switch during the awaits invalidates the preview — bail if so.
  if (!el || activeDoc !== doc || previewEl) return;
  jsonBar.hidden = true;
  hostEl.style.display = 'none';
  diffBody.appendChild(el);
  previewEl = el;
  syncToggle();
}

async function markdownPreview(doc) {
  const { renderMarkdownPreview } = await import('../editor/markdown-preview.js');
  return renderMarkdownPreview(doc.model.getValue(), baseDirOf(doc), (href) => {
    if (/^https?:/i.test(href)) openLink('url', href);
    else openLink('path', decodeURIComponent(href.replace(/^file:\/\//, '')), baseDirOf(doc));
  });
}

async function htmlPreview(doc) {
  await saveActiveFile(); // preview what the user sees, not stale disk
  const r = await window.api.fileUrl(doc.file);
  if (!r || !r.ok) { if (r) console.error('preview failed:', r.error); return null; }
  const el = document.createElement('webview');
  el.className = 'editor-preview';
  el.setAttribute('src', r.url);
  return el;
}

function exitPreviewDom() {
  if (previewEl) { previewEl.remove(); previewEl = null; }
  if (hostEl) hostEl.style.display = '';
}

function exitPreview() {
  if (!previewEl) return;
  exitPreviewDom();
  syncJsonBar();
  syncToggle();
  if (editor) requestAnimationFrame(() => { editor.layout(); editor.focus(); });
}

function setPreview(on) { if (on) enterPreview(); else exitPreview(); }
previewToggle.onclick = (e) => {
  const opt = e.target.closest('.seg-opt');
  setPreview(opt ? opt.dataset.mode === 'preview' : !previewEl);
};
previewToggle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreview(!previewEl); }
});

// ── JSON structure actions ──────────────────────────────────────────────────
// For .json files a floating pill offers "+ Item" / "+ Key" for the innermost
// array/object the caret sits in (pure helper: shared/json-edit.js). The insert
// is one undoable edit; then the placeholder is selected so typing replaces it.

const MAX_JSON_BAR_CHARS = 1_000_000;
function currentJsonInsertion() {
  const doc = activeDoc;
  const pos = editor && editor.getPosition();
  if (!doc || doc.readOnly || previewEl || !pos || extOf(doc.file) !== 'json') return null;
  // A huge JSON file (a lockfile) would be copied and scanned from the top on every
  // cursor move; the add-item helper isn't worth that.
  if (doc.model.getValueLength() > MAX_JSON_BAR_CHARS) return null;
  return jsonInsertion(doc.model.getValue(), doc.model.getOffsetAt(pos));
}

function syncJsonBar() {
  const ins = currentJsonInsertion();
  jsonBar.hidden = !ins;
  if (!ins) return;
  jsonAddItemBtn.hidden = ins.type !== 'array';
  jsonAddKeyBtn.hidden = ins.type !== 'object';
}

function applyJsonInsertion() {
  const ins = currentJsonInsertion();
  if (!ins) return;
  const model = activeDoc.model;
  const at = model.getPositionAt(ins.at);
  editor.pushUndoStop();
  editor.executeEdits('json-insert', [{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: ins.insert }]);
  editor.pushUndoStop();
  const s = model.getPositionAt(ins.selStart);
  const e = model.getPositionAt(ins.selEnd);
  editor.setSelection(new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column));
  editor.revealPositionInCenterIfOutsideViewport(s);
  editor.focus();
}

// mousedown would move focus (and the caret context) before click lands.
jsonBar.addEventListener('mousedown', (e) => e.preventDefault());
jsonAddItemBtn.onclick = applyJsonInsertion;
jsonAddKeyBtn.onclick = applyJsonInsertion;

preloadMonacoWhenIdle();
