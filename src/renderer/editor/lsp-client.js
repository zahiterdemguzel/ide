// Language Server Protocol client for the Monaco editor.
//
// main/lsp.js spawns servers and pipes raw JSON-RPC; everything protocol-level
// lives here: the initialize handshake, document sync, Monaco providers built from
// each server's advertised capabilities, diagnostics, and server→client requests.
// Pure shape conversions live in lsp-convert.js (unit-tested); this file is the
// stateful wiring and is deliberately the only one that touches `monaco`.
//
// Model: one LspConnection per running server (per project root). A Monaco
// language id is bound to at most one connection; a connection may serve several
// language ids (TypeScript serves javascript + typescript, clangd c + cpp + …).
// Servers start lazily, the first time a model of their language is tracked.
//
// See .claude/memory/lsp.md.

import * as conv from './lsp-convert.js';

const LSP_COMMAND_ID = 'lsp.executeServerCommand';
const INITIALIZE_TIMEOUT_MS = 120000; // jdtls / metals can take a long while to come up
const SHUTDOWN_TIMEOUT_MS = 2000;
const PULL_DIAGNOSTICS_DELAY_MS = 250;
const DIAGNOSTICS_NOTIFY_DELAY_MS = 50;
const CRASH_RESTART_LIMIT = 3; // automatic restarts allowed …
const CRASH_RESTART_WINDOW_MS = 3 * 60 * 1000; // … within this window

// JSON-RPC errors that just mean "your answer is stale" — not worth logging.
const QUIET_ERROR_CODES = new Set([-32800, -32801, -32802]);

let monaco = null;
let host = null;
let api = null;

let activeRoot; // project root the running servers belong to (undefined = none chosen yet)
let rootGeneration = 0; // bumped on every root switch, to drop late results from the old root

const connections = new Map(); // key -> LspConnection
const draining = new Map(); // key -> a stopped LspConnection still finishing its shutdown handshake
const languageBindings = new Map(); // languageId -> { promise, connection, unknown }
const statusByLanguage = new Map(); // languageId -> { state, name, message }
const trackedDocs = new Map(); // model.uri.toString() -> TrackedDoc
const diagnosticsByUri = new Map(); // normalized uri -> { uri, path, byOwner: Map(owner -> Diagnostic[]) }
const diagnosticsListeners = new Set();
const crashTimes = new Map(); // serverId -> [timestamps of unexpected exits]
const builtinTsDiagnostics = new Map(); // languageId -> the diagnostics options we replaced
let diagnosticsNotifyTimer = null;

// ── Public API ──────────────────────────────────────────────────────────────

// Once, after Monaco loads — and before the first JavaScript/TypeScript model is
// created: Monaco 0.57 reads its built-in TS worker's feature switches only once,
// when that language first activates (see suppressBuiltinTypeScriptFeatures).
export function initLsp(monacoNamespace, editorHost) {
  monaco = monacoNamespace;
  host = editorHost || {};
  api = window.api;
  suppressBuiltinTypeScriptFeatures();
  monaco.editor.registerCommand(LSP_COMMAND_ID, (_accessor, key, command) => {
    const connection = connections.get(key);
    if (connection) connection.executeCommand(command);
  });
  // A renderer reload loses this module's state while main keeps the servers
  // alive; they'd reject a second initialize, so start from a clean slate.
  api.lspStopAll();
  api.onLspMessage(({ key, message }) => {
    const connection = connections.get(key) || draining.get(key);
    if (!connection) return;
    let parsed;
    try { parsed = JSON.parse(message); } catch { return; }
    connection.receive(parsed);
  });
  api.onLspExit(({ key, code, signal, error }) => {
    const connection = connections.get(key);
    if (connection) connection.handleExit({ code, signal, error });
  });
  // Opening another folder: wait a tick so the host's own folder-changed handler
  // has updated getRoot() before we compare.
  if (api.onFolderChanged) api.onFolderChanged(() => setTimeout(checkRoot, 0));
}

export function lspTrackModel(model) {
  if (!monaco || !model || model.isDisposed() || model.uri.scheme !== 'file') return;
  const id = model.uri.toString();
  if (trackedDocs.has(id)) return;
  const fsPath = model.uri.fsPath;
  const lspUri = conv.pathToUri(fsPath);
  const doc = {
    model, fsPath, lspUri,
    normalized: conv.normalizeUri(lspUri),
    languageId: model.getLanguageId(),
    connection: null,
    attachPromise: null,
    pullTimer: null,
    pullResultId: null,
    lastSignatureHelp: null,
    disposables: [],
  };
  trackedDocs.set(id, doc);
  doc.disposables.push(
    model.onDidChangeContent((e) => { if (doc.connection) doc.connection.documentChanged(doc, e); }),
    model.onDidChangeLanguage(() => {
      if (doc.connection) doc.connection.closeDocument(doc);
      doc.languageId = model.getLanguageId();
      attachDoc(doc);
    }),
    model.onWillDispose(() => untrackDoc(id)),
  );
  applyStoredMarkers(doc);
  checkRoot();
  attachDoc(doc);
}

export function lspNotifySaved(model) {
  const doc = model && trackedDocs.get(model.uri.toString());
  if (doc && doc.connection) doc.connection.documentSaved(doc);
}

export function lspStatus(languageId) {
  return statusByLanguage.get(languageId) || null;
}

export async function lspDocumentSymbols(model) {
  const doc = model && trackedDocs.get(model.uri.toString());
  if (!doc) return null;
  if (doc.attachPromise) await doc.attachPromise;
  const connection = doc.connection;
  if (!connection || !connection.capabilities().documentSymbolProvider) return null;
  try {
    const result = await connection.request('textDocument/documentSymbol', { textDocument: { uri: doc.lspUri } });
    return conv.documentSymbolsToMonaco(result);
  } catch (e) {
    connection.logRequestError('textDocument/documentSymbol', e);
    return null;
  }
}

export async function lspWorkspaceSymbols(query, languageId) {
  const candidates = languageId
    ? [languageBindings.get(languageId)?.connection].filter(Boolean)
    : [...connections.values()];
  const ready = candidates.filter((c) => c.state === 'ready' && c.capabilities().workspaceSymbolProvider);
  const results = await Promise.all(ready.map((c) => c.request('workspace/symbol', { query: query || '' }).catch(() => null)));
  return results.flatMap((list) => (Array.isArray(list) ? list : [])).map((symbol) => {
    const plain = conv.workspaceSymbolToPlain(symbol);
    const fsPath = conv.uriToPath(plain.uri);
    return {
      ...plain,
      uri: fsPath ? monaco.Uri.file(fsPath).toString() : plain.uri,
      range: plain.range || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    };
  });
}

export function onDiagnosticsChanged(cb) {
  diagnosticsListeners.add(cb);
  return { dispose: () => diagnosticsListeners.delete(cb) };
}

export function getAllDiagnostics() {
  const out = [];
  for (const entry of diagnosticsByUri.values()) {
    const diagnostics = [...entry.byOwner.values()].flat().map((d) => ({
      severity: conv.severityToMonaco(d.severity),
      message: d.message,
      range: conv.toMonacoRange(d.range),
      source: d.source,
      code: d.code,
    }));
    if (!diagnostics.length) continue;
    out.push({ uri: entry.path ? monaco.Uri.file(entry.path).toString() : entry.uri, path: entry.path, diagnostics });
  }
  return out;
}

export async function lspRestart(languageId) {
  const binding = languageBindings.get(languageId);
  const connection = binding && binding.connection;
  const languages = connection ? [...connection.languages] : [languageId];
  for (const lang of languages) languageBindings.delete(lang);
  if (connection) await connection.stop();
  crashTimes.delete(connection ? connection.serverId : languageId);
  for (const doc of trackedDocs.values()) {
    if (languages.includes(doc.languageId)) attachDoc(doc);
  }
}

// ── Roots, bindings, document attachment ───────────────────────────────────

function currentRoot() {
  return (host.getRoot && host.getRoot()) || null;
}

// Servers are per project: when the user opens another folder, shut down the old
// root's servers and re-attach whatever is still open to fresh ones.
function checkRoot() {
  const root = currentRoot();
  if (activeRoot === undefined) { activeRoot = root; return; }
  if (root === activeRoot) return;
  activeRoot = root;
  rootGeneration++;
  for (const connection of [...connections.values()]) connection.stop();
  languageBindings.clear();
  for (const languageId of [...statusByLanguage.keys()]) setStatus(languageId, 'stopped', statusByLanguage.get(languageId).name, '');
  for (const doc of trackedDocs.values()) {
    doc.connection = null;
    attachDoc(doc);
  }
}

function attachDoc(doc) {
  const generation = rootGeneration;
  const languageId = doc.languageId;
  doc.attachPromise = (async () => {
    const connection = await bindLanguage(languageId, activeRoot || dirname(doc.fsPath));
    const stillWanted = trackedDocs.get(doc.model.uri.toString()) === doc
      && doc.languageId === languageId && generation === rootGeneration && !doc.model.isDisposed();
    if (connection && stillWanted && connection.state === 'ready' && doc.connection !== connection) {
      connection.openDocument(doc);
    }
  })();
  return doc.attachPromise;
}

// The connection serving `languageId`, starting its server if needed. Resolves to
// null when the language has no server (or it couldn't start). The result is
// cached per language, failures included, until lspRestart or a root switch.
function bindLanguage(languageId, root) {
  const existing = languageBindings.get(languageId);
  if (existing) return existing.promise;
  const binding = { connection: null, promise: null };
  const generation = rootGeneration;
  const isCurrent = () => generation === rootGeneration && languageBindings.get(languageId) === binding;
  binding.promise = (async () => {
    const info = await ensureServer(languageId, root);
    if (!isCurrent()) return null;
    if (!info || !info.ok) {
      // A language with no known server (plain text, markdown…) gets no status at all.
      if (info && !info.unknown) setStatus(languageId, 'unavailable', info.name, info.reason || 'No language server available.');
      return null;
    }
    let connection = connections.get(info.key);
    if (!connection) {
      connection = new LspConnection(info, root);
      connections.set(info.key, connection);
      setStatus(languageId, 'starting', info.name, '');
      connection.startPromise = connection.start();
    }
    try {
      await connection.startPromise;
    } catch (e) {
      connection.stop();
      if (isCurrent()) setStatus(languageId, 'error', info.name, e.message);
      return null;
    }
    if (!isCurrent() || connection.state !== 'ready') return null;
    binding.connection = connection;
    connection.attachLanguage(languageId);
    setStatus(languageId, 'ready', connection.name, '');
    return connection;
  })();
  languageBindings.set(languageId, binding);
  return binding.promise;
}

// main's `lsp-ensure`. A server main reports as already running that this client
// doesn't know (left over from a renderer reload) can't be re-initialized, so it
// is replaced with a fresh one.
async function ensureServer(languageId, root) {
  const info = await api.lspEnsure(languageId, root);
  if (!info || !info.ok || !info.reused || connections.has(info.key)) return info;
  await api.lspStop(info.key);
  return api.lspEnsure(languageId, root);
}

function untrackDoc(id) {
  const doc = trackedDocs.get(id);
  if (!doc) return;
  trackedDocs.delete(id);
  clearTimeout(doc.pullTimer);
  if (doc.connection) doc.connection.closeDocument(doc);
  for (const d of doc.disposables) d.dispose();
}

function readyConnectionFor(languageId) {
  return [...connections.values()].find((c) => c.state === 'ready' && c.languages.has(languageId)) || null;
}

function setStatus(languageId, state, name, message) {
  const status = { state, name: name || '', message: message || '' };
  statusByLanguage.set(languageId, status);
  if (host.onStatus) {
    try { host.onStatus(languageId, status); } catch (e) { console.error('[lsp] onStatus', e); }
  }
}

function dirname(fsPath) {
  return fsPath.replace(/[\\/][^\\/]*$/, '') || fsPath;
}

// ── URI → model resolution ──────────────────────────────────────────────────

function findModelByNormalizedUri(key) {
  for (const doc of trackedDocs.values()) if (doc.normalized === key) return doc.model;
  return monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && conv.normalizeUri(m.uri.toString()) === key) || null;
}

// A server URI → the monaco.Uri of a model holding that file, loading the file
// into a model first when none exists (Monaco's peek/rename/navigation all need
// a model for every location they touch).
async function resolveModelUri(uriString) {
  const existing = findModelByNormalizedUri(conv.normalizeUri(uriString));
  if (existing) return existing.uri;
  const fsPath = conv.uriToPath(uriString);
  if (!fsPath) return monaco.Uri.parse(uriString);
  const target = monaco.Uri.file(fsPath);
  if (host.ensureModel) {
    try {
      const model = await host.ensureModel(target);
      if (model) return model.uri;
    } catch (e) { console.warn('[lsp] ensureModel failed for', fsPath, e); }
  }
  return target;
}

function uriForMarker(uriString) {
  const fsPath = conv.uriToPath(uriString);
  return fsPath ? monaco.Uri.file(fsPath) : monaco.Uri.parse(uriString);
}

async function toMonacoWorkspaceEdit(lspEdit) {
  const { entries, fileOperations } = conv.workspaceEditEntries(lspEdit);
  if (fileOperations.length) console.warn('[lsp] ignoring file operations in a workspace edit', fileOperations);
  const edits = [];
  for (const entry of entries) {
    const resource = await resolveModelUri(entry.uri);
    for (const textEdit of entry.edits) edits.push({ resource, textEdit, versionId: undefined });
  }
  return { edits };
}

// `workspace/applyEdit` from a server: apply directly to the models (one undo
// step per document), loading any file that isn't open yet.
async function applyWorkspaceEdit(lspEdit) {
  const { entries } = conv.workspaceEditEntries(lspEdit);
  const targets = [];
  for (const entry of entries) {
    const model = monaco.editor.getModel(await resolveModelUri(entry.uri));
    if (!model) return false;
    targets.push({ model, edits: entry.edits });
  }
  for (const { model, edits } of targets) {
    model.pushStackElement();
    model.pushEditOperations([], edits.map((e) => ({ range: e.range, text: e.text })), () => null);
    model.pushStackElement();
  }
  return true;
}

// ── Diagnostics store ───────────────────────────────────────────────────────
// Kept per file (normalized URI) and per server ("owner"), whether or not the file
// has a model: the Problems view lists them all, and markers are applied when a
// model for the file appears later.

function setDiagnostics(owner, uri, diagnostics) {
  const key = conv.normalizeUri(uri);
  let entry = diagnosticsByUri.get(key);
  if (!entry) {
    entry = { uri, path: conv.uriToPath(uri), byOwner: new Map() };
    diagnosticsByUri.set(key, entry);
  }
  if (diagnostics && diagnostics.length) entry.byOwner.set(owner, diagnostics);
  else entry.byOwner.delete(owner);
  if (!entry.byOwner.size) diagnosticsByUri.delete(key);
  const model = findModelByNormalizedUri(key);
  if (model) monaco.editor.setModelMarkers(model, owner, (diagnostics || []).map((d) => conv.diagnosticToMarker(d, uriForMarker)));
  scheduleDiagnosticsNotify();
}

function clearOwnerDiagnostics(owner) {
  for (const [key, entry] of [...diagnosticsByUri]) {
    if (!entry.byOwner.delete(owner)) continue;
    if (!entry.byOwner.size) diagnosticsByUri.delete(key);
  }
  for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, owner, []);
  scheduleDiagnosticsNotify();
}

function applyStoredMarkers(doc) {
  const entry = diagnosticsByUri.get(doc.normalized);
  if (!entry) return;
  for (const [owner, diagnostics] of entry.byOwner) {
    monaco.editor.setModelMarkers(doc.model, owner, diagnostics.map((d) => conv.diagnosticToMarker(d, uriForMarker)));
  }
}

function storedDiagnostics(owner, normalizedUri) {
  const entry = diagnosticsByUri.get(normalizedUri);
  return (entry && entry.byOwner.get(owner)) || [];
}

function scheduleDiagnosticsNotify() {
  if (diagnosticsNotifyTimer) return;
  diagnosticsNotifyTimer = setTimeout(() => {
    diagnosticsNotifyTimer = null;
    for (const cb of diagnosticsListeners) {
      try { cb(); } catch (e) { console.error('[lsp] diagnostics listener', e); }
    }
  }, DIAGNOSTICS_NOTIFY_DELAY_MS);
}

// ── Monaco's built-in TypeScript worker ─────────────────────────────────────
// With the bundled TypeScript server serving JS/TS, Monaco's own TS worker would
// duplicate every completion, hover and squiggle. Monaco 0.57 registers the
// worker's providers once, when the language first activates, from
// `modeConfiguration` — later changes are ignored — so the providers are switched
// off up front. Only its diagnostics stay toggleable (they re-read
// `diagnosticsOptions` on change): they stay on until the server is ready and come
// back if it stops, so a JS/TS file is never left with nothing at all.

function builtinTsDefaults(languageId) {
  const ns = (monaco.typescript && monaco.typescript.typescriptDefaults && monaco.typescript)
    || (monaco.languages.typescript && monaco.languages.typescript.typescriptDefaults && monaco.languages.typescript)
    || null;
  if (!ns) return null;
  if (languageId === 'typescript') return ns.typescriptDefaults;
  if (languageId === 'javascript') return ns.javascriptDefaults;
  return null;
}

function suppressBuiltinTypeScriptFeatures() {
  const providersOff = {
    completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false,
    documentHighlights: false, rename: false, documentRangeFormattingEdits: false, signatureHelp: false,
    onTypeFormattingEdits: false, codeActions: false, inlayHints: false,
    diagnostics: true,
  };
  for (const languageId of ['typescript', 'javascript']) {
    const defaults = builtinTsDefaults(languageId);
    if (defaults) defaults.setModeConfiguration(providersOff);
  }
}

function setBuiltinTsDiagnostics(languageId, enabled) {
  const defaults = builtinTsDefaults(languageId);
  if (!defaults) return;
  if (!enabled && !builtinTsDiagnostics.has(languageId)) {
    const original = defaults.getDiagnosticsOptions();
    builtinTsDiagnostics.set(languageId, original);
    defaults.setDiagnosticsOptions({ ...original, noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
  } else if (enabled && builtinTsDiagnostics.has(languageId)) {
    defaults.setDiagnosticsOptions(builtinTsDiagnostics.get(languageId));
    builtinTsDiagnostics.delete(languageId);
  }
}

// ── Client capabilities ─────────────────────────────────────────────────────

const numbersFrom = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property',
  'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
  'regexp', 'operator', 'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification',
  'documentation', 'defaultLibrary',
];

const CLIENT_CAPABILITIES = {
  general: {
    positionEncodings: ['utf-16'],
    markdown: { parser: 'marked', version: '1.1.0' },
    staleRequestSupport: { cancel: true, retryOnContentModified: [] },
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: 'abort', normalizesLineEndings: true },
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: { dynamicRegistration: false },
    symbol: {
      dynamicRegistration: true,
      symbolKind: { valueSet: numbersFrom(1, 26) },
      tagSupport: { valueSet: [1] },
    },
    executeCommand: { dynamicRegistration: true },
    workspaceFolders: true,
    configuration: true,
    semanticTokens: { refreshSupport: true },
    codeLens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
    diagnostics: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: true,
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits', 'command'] },
        labelDetailsSupport: true,
        insertTextModeSupport: { valueSet: [1, 2] },
      },
      completionItemKind: { valueSet: numbersFrom(1, 25) },
      completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'insertTextMode', 'data'] },
    },
    hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    implementation: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: numbersFrom(1, 26) },
      tagSupport: { valueSet: [1] },
      labelSupport: true,
    },
    codeAction: {
      dynamicRegistration: true,
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit', 'command'] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'],
        },
      },
    },
    codeLens: { dynamicRegistration: true },
    documentLink: { dynamicRegistration: true, tooltipSupport: true },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true, prepareSupportDefaultBehavior: 1 },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    foldingRange: {
      dynamicRegistration: true,
      lineFoldingOnly: true,
      foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] },
    },
    selectionRange: { dynamicRegistration: true },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: { delta: true } },
      tokenTypes: SEMANTIC_TOKEN_TYPES,
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
      serverCancelSupport: true,
      augmentsSyntaxTokens: true,
    },
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: { properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'] },
    },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
  },
  window: {
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
    showDocument: { support: false },
  },
};

// ── One server connection ───────────────────────────────────────────────────

class LspConnection {
  constructor(info, root) {
    this.key = info.key;
    this.serverId = info.serverId;
    this.name = info.name;
    this.settings = info.settings || {};
    this.initializationOptions = info.initializationOptions;
    this.root = root;
    this.rootUri = root ? conv.pathToUri(root) : null;
    this.owner = `lsp-${info.serverId}`;
    this.state = 'starting'; // starting | ready | stopping | stopped
    this.stopRequested = false;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, method, timer, cancelSubscription }
    this.serverCapabilities = {};
    this.registrations = new Map(); // registration id -> { method, registerOptions }
    this.languages = new Set();
    this.providers = new Map(); // languageId -> IDisposable[]
    this.docs = new Map(); // normalized uri -> doc
    this.sync = conv.textSyncOptions(undefined);
    this.startPromise = null;
    // Per-connection metadata Monaco objects don't carry, keyed by the object
    // Monaco hands back to resolve* calls.
    this.completionSource = new WeakMap();
    this.codeActionSource = new WeakMap();
    this.codeLensSource = new WeakMap();
    this.inlayHintSource = new WeakMap();
    this.linkSource = new WeakMap();
    this.semanticTokensChanged = new monaco.Emitter();
    this.codeLensesChanged = new monaco.Emitter();
    this.inlayHintsChanged = new monaco.Emitter();
  }

  capabilities() {
    return conv.effectiveCapabilities(this.serverCapabilities, this.registrations);
  }

  // ── JSON-RPC ──

  send(message) {
    api.lspSend(this.key, JSON.stringify({ jsonrpc: '2.0', ...message }));
  }

  notify(method, params) {
    if (this.state === 'stopped' && method !== 'exit') return;
    this.send({ method, params });
  }

  // Resolves with the result, or null when Monaco cancels (after telling the
  // server via $/cancelRequest). Rejects with the server's error.
  request(method, params, token, timeoutMs = 0) {
    // A stopped connection still sends `shutdown` while it drains (see stop()).
    if (this.state === 'stopped' && method !== 'shutdown') return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (token && token.isCancellationRequested) { resolve(null); return; }
      const entry = { resolve, reject, method, timer: null, cancelSubscription: null };
      if (token) {
        entry.cancelSubscription = token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.finish(id);
          this.notify('$/cancelRequest', { id });
          resolve(null);
        });
      }
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.finish(id);
          reject(new Error(`${this.name}: "${method}" timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ id, method, params });
    });
  }

  finish(id) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.cancelSubscription) entry.cancelSubscription.dispose();
    return entry;
  }

  receive(message) {
    if (message.method && message.id !== undefined) this.handleServerRequest(message);
    else if (message.method) this.handleNotification(message);
    else if (message.id !== undefined) {
      const entry = this.finish(message.id);
      if (!entry) return;
      if (message.error) {
        const error = new Error(message.error.message || `${entry.method} failed`);
        error.code = message.error.code;
        entry.reject(error);
      } else {
        entry.resolve(message.result ?? null);
      }
    }
  }

  async handleServerRequest(message) {
    try {
      const result = await this.serverRequestResult(message.method, message.params || {});
      this.send({ id: message.id, result: result === undefined ? null : result });
    } catch (e) {
      this.send({ id: message.id, error: { code: e.code || -32603, message: e.message || String(e) } });
    }
  }

  async serverRequestResult(method, params) {
    switch (method) {
      case 'workspace/configuration':
        return (params.items || []).map((item) => conv.configurationSection(this.settings, item.section));
      case 'workspace/workspaceFolders':
        return this.workspaceFolders();
      case 'client/registerCapability':
        for (const r of params.registrations || []) this.registrations.set(r.id, { method: r.method, registerOptions: r.registerOptions });
        this.refreshProviders();
        return null;
      case 'client/unregisterCapability':
        // The spec's field really is spelled "unregisterations".
        for (const u of params.unregisterations || params.unregistrations || []) this.registrations.delete(u.id);
        this.refreshProviders();
        return null;
      case 'window/workDoneProgress/create':
        return null;
      case 'window/showMessageRequest':
        console.info(`[lsp:${this.serverId}]`, params.message);
        return null;
      case 'window/showDocument':
        return { success: false };
      case 'workspace/applyEdit':
        return { applied: await applyWorkspaceEdit(params.edit) };
      case 'workspace/semanticTokens/refresh':
        this.semanticTokensChanged.fire();
        return null;
      case 'workspace/codeLens/refresh':
        this.codeLensesChanged.fire(undefined);
        return null;
      case 'workspace/inlayHint/refresh':
        this.inlayHintsChanged.fire();
        return null;
      case 'workspace/diagnostic/refresh':
        for (const doc of this.docs.values()) this.schedulePull(doc);
        return null;
      default: {
        const error = new Error(`Unhandled method ${method}`);
        error.code = -32601;
        throw error;
      }
    }
  }

  handleNotification({ method, params }) {
    switch (method) {
      case 'textDocument/publishDiagnostics':
        setDiagnostics(this.owner, params.uri, params.diagnostics || []);
        break;
      case 'window/showMessage':
        (params.type === 1 ? console.error : params.type === 2 ? console.warn : console.info)(`[lsp:${this.serverId}]`, params.message);
        break;
      case 'window/logMessage':
        if (params.type === 1) console.error(`[lsp:${this.serverId}]`, params.message);
        else console.debug(`[lsp:${this.serverId}]`, params.message);
        break;
      default:
        break; // $/progress, telemetry/event, …
    }
  }

  logRequestError(method, error) {
    if (error && QUIET_ERROR_CODES.has(error.code)) return;
    if (this.state !== 'ready') return;
    console.warn(`[lsp:${this.serverId}] ${method}:`, error && error.message);
  }

  workspaceFolders() {
    if (!this.rootUri) return null;
    return [{ uri: this.rootUri, name: this.root.split(/[\\/]/).filter(Boolean).pop() || this.root }];
  }

  // ── Lifecycle ──

  async start() {
    const result = await this.request('initialize', {
      processId: null,
      clientInfo: { name: 'Claude Session Editor' },
      locale: navigator.language,
      rootPath: this.root,
      rootUri: this.rootUri,
      workspaceFolders: this.workspaceFolders(),
      initializationOptions: this.initializationOptions,
      capabilities: CLIENT_CAPABILITIES,
      trace: 'off',
    }, null, INITIALIZE_TIMEOUT_MS);
    if (this.state !== 'starting') throw new Error(`${this.name} stopped while starting`);
    this.serverCapabilities = (result && result.capabilities) || {};
    if (result && result.serverInfo && result.serverInfo.name) this.name = result.serverInfo.name;
    this.sync = conv.textSyncOptions(this.serverCapabilities.textDocumentSync);
    this.state = 'ready';
    this.notify('initialized', {});
    if (Object.keys(this.settings).length) this.notify('workspace/didChangeConfiguration', { settings: this.settings });
  }

  // Forget the server at once (so nothing waits on it and a replacement can take
  // over), then shut it down gracefully: shutdown → exit, and main kills the
  // process if it lingers.
  async stop() {
    if (this.stopRequested || this.state === 'stopped') return;
    this.stopRequested = true;
    const wasReady = this.state === 'ready';
    const languages = [...this.languages];
    this.teardown();
    for (const languageId of languages) {
      if (!languageBindings.has(languageId)) setStatus(languageId, 'stopped', this.name, '');
    }
    if (wasReady) {
      draining.set(this.key, this);
      // No `params` at all: TypeScript's native server rejects `"params": null` here
      // (JSON.stringify drops the undefined field).
      try { await this.request('shutdown', undefined, null, SHUTDOWN_TIMEOUT_MS); } catch { /* exiting anyway */ }
      this.notify('exit', undefined);
      if (draining.get(this.key) === this) draining.delete(this.key);
    }
    await api.lspStop(this.key);
  }

  handleExit({ code, signal, error }) {
    if (this.stopRequested) return;
    const detail = error || (signal ? `terminated by ${signal}` : `exited with code ${code}`);
    const languages = [...this.languages];
    const wasReady = this.state === 'ready';
    this.teardown(`${this.name} stopped: ${detail}`);
    console.warn(`[lsp:${this.serverId}] server exited: ${detail}`);
    // A server that dies before it ever became ready fails its startup instead
    // (bindLanguage reports that); only a crash of a working server restarts.
    if (!wasReady) return;
    const now = Date.now();
    const recent = (crashTimes.get(this.serverId) || []).filter((t) => now - t < CRASH_RESTART_WINDOW_MS);
    recent.push(now);
    crashTimes.set(this.serverId, recent);
    if (recent.length > CRASH_RESTART_LIMIT) {
      for (const lang of languages) setStatus(lang, 'error', this.name, `${this.name} keeps crashing (${detail}).`);
      return;
    }
    for (const doc of trackedDocs.values()) {
      if (languages.includes(doc.languageId)) attachDoc(doc);
    }
  }

  // Forget everything about this connection: pending requests, providers,
  // diagnostics, open documents, language bindings. Careful to leave alone
  // anything a newer connection (same server, new root) has already taken over.
  teardown(reason) {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    for (const id of [...this.pending.keys()]) this.finish(id).reject(new Error(reason || `${this.name} stopped`));
    if (connections.get(this.key) === this) connections.delete(this.key);
    for (const languageId of this.languages) {
      this.disposeProviders(languageId);
      const binding = languageBindings.get(languageId);
      if (binding && binding.connection === this) languageBindings.delete(languageId);
      if (this.serverId === 'typescript' && !readyConnectionFor(languageId)) setBuiltinTsDiagnostics(languageId, true);
    }
    for (const doc of this.docs.values()) {
      clearTimeout(doc.pullTimer);
      if (doc.connection === this) doc.connection = null;
    }
    this.docs.clear();
    if (![...connections.values()].some((c) => c.owner === this.owner)) clearOwnerDiagnostics(this.owner);
  }

  attachLanguage(languageId) {
    if (this.languages.has(languageId)) return;
    this.languages.add(languageId);
    this.registerProviders(languageId);
    if (this.serverId === 'typescript') setBuiltinTsDiagnostics(languageId, false);
  }

  // ── Document sync ──

  openDocument(doc) {
    if (doc.connection && doc.connection !== this) doc.connection.closeDocument(doc);
    doc.connection = this;
    doc.pullResultId = null;
    this.docs.set(doc.normalized, doc);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: doc.lspUri,
        languageId: conv.lspLanguageId(doc.languageId, doc.fsPath),
        version: doc.model.getVersionId(),
        text: doc.model.getValue(),
      },
    });
    this.schedulePull(doc);
  }

  documentChanged(doc, event) {
    if (this.state !== 'ready') return;
    let contentChanges;
    if (this.sync.change === 2) contentChanges = conv.contentChangesToLsp(event.changes);
    else if (this.sync.change === 1) contentChanges = [{ text: doc.model.getValue() }];
    else return;
    this.notify('textDocument/didChange', { textDocument: { uri: doc.lspUri, version: doc.model.getVersionId() }, contentChanges });
    this.schedulePull(doc);
  }

  documentSaved(doc) {
    if (this.state !== 'ready' || !this.sync.save) return;
    this.notify('textDocument/didSave', {
      textDocument: { uri: doc.lspUri },
      ...(this.sync.save.includeText ? { text: doc.model.getValue() } : {}),
    });
  }

  closeDocument(doc) {
    clearTimeout(doc.pullTimer);
    if (doc.connection === this) doc.connection = null;
    if (!this.docs.delete(doc.normalized)) return;
    if (this.state === 'ready') this.notify('textDocument/didClose', { textDocument: { uri: doc.lspUri } });
    // Pulled diagnostics have no "closed" signal from the server; drop them here.
    if (this.capabilities().diagnosticProvider) setDiagnostics(this.owner, doc.lspUri, []);
  }

  // ── Pull diagnostics (textDocument/diagnostic) ──

  schedulePull(doc) {
    if (!this.capabilities().diagnosticProvider) return;
    clearTimeout(doc.pullTimer);
    doc.pullTimer = setTimeout(() => this.pullDiagnostics(doc), PULL_DIAGNOSTICS_DELAY_MS);
  }

  async pullDiagnostics(doc) {
    if (this.state !== 'ready' || doc.connection !== this) return;
    const provider = this.capabilities().diagnosticProvider;
    try {
      const report = await this.request('textDocument/diagnostic', {
        textDocument: { uri: doc.lspUri },
        identifier: provider && provider.identifier,
        previousResultId: doc.pullResultId || undefined,
      });
      if (!report || doc.connection !== this) return;
      this.applyDiagnosticReport(doc.lspUri, report, doc);
      for (const [uri, related] of Object.entries(report.relatedDocuments || {})) this.applyDiagnosticReport(uri, related, null);
    } catch (e) {
      this.logRequestError('textDocument/diagnostic', e);
    }
  }

  applyDiagnosticReport(uri, report, doc) {
    if (report.kind !== 'full') return; // 'unchanged': keep what we have
    if (doc) doc.pullResultId = report.resultId || null;
    setDiagnostics(this.owner, uri, report.items || []);
  }

  // ── Commands ──

  // An LSP Command → a Monaco command. Commands the server executes go through
  // our registered LSP_COMMAND_ID; Monaco's own `editor.*` commands pass through.
  toMonacoCommand(command) {
    if (!command) return undefined;
    const serverCommands = (this.capabilities().executeCommandProvider || {}).commands || [];
    if (command.command.startsWith('editor.') && !serverCommands.includes(command.command)) {
      return { id: command.command, title: command.title, arguments: command.arguments };
    }
    return { id: LSP_COMMAND_ID, title: command.title, arguments: [this.key, command] };
  }

  // `editor.action.showReferences` arrives with LSP-shaped (uri, position,
  // locations) arguments; Monaco's command wants its own types and a model for
  // every location — so convert, loading files first.
  async toMonacoCommandResolved(command) {
    if (!command || command.command !== 'editor.action.showReferences' || !Array.isArray(command.arguments)) {
      return this.toMonacoCommand(command);
    }
    const [uri, position, locations] = command.arguments;
    return {
      id: command.command,
      title: command.title,
      arguments: [
        await resolveModelUri(uri),
        new monaco.Position(position.line + 1, position.character + 1),
        await this.toMonacoLocations(conv.locationsFrom(locations || [])),
      ],
    };
  }

  async executeCommand(command) {
    try {
      await this.request('workspace/executeCommand', { command: command.command, arguments: command.arguments });
    } catch (e) {
      console.warn(`[lsp:${this.serverId}] command ${command.command} failed:`, e.message);
    }
  }

  async toMonacoLocations(locations) {
    const out = [];
    for (const loc of locations) out.push({ ...loc, uri: await resolveModelUri(loc.uri) });
    return out;
  }

  // ── Providers ──

  docFor(model) {
    if (this.state !== 'ready' || !model || model.uri.scheme !== 'file') return null;
    const doc = trackedDocs.get(model.uri.toString());
    return doc && doc.connection === this ? doc : null;
  }

  // Run a provider body for a model this server has open; any failure → null so a
  // misbehaving server never breaks the editor.
  async withDoc(model, method, body) {
    const doc = this.docFor(model);
    if (!doc) return null;
    try {
      return await body(doc, { uri: doc.lspUri });
    } catch (e) {
      this.logRequestError(method, e);
      return null;
    }
  }

  disposeProviders(languageId) {
    for (const d of this.providers.get(languageId) || []) d.dispose();
    this.providers.delete(languageId);
  }

  refreshProviders() {
    for (const languageId of this.languages) this.registerProviders(languageId);
  }

  registerProviders(languageId) {
    this.disposeProviders(languageId);
    const caps = this.capabilities();
    const L = monaco.languages;
    const list = [];
    const add = (capability, register) => { if (caps[capability]) list.push(register(caps[capability])); };

    add('completionProvider', (opts) => L.registerCompletionItemProvider(languageId, this.completionProvider(opts)));
    add('hoverProvider', () => L.registerHoverProvider(languageId, this.hoverProvider()));
    add('signatureHelpProvider', (opts) => L.registerSignatureHelpProvider(languageId, this.signatureHelpProvider(opts)));
    add('definitionProvider', () => L.registerDefinitionProvider(languageId, { provideDefinition: this.locationRequest('textDocument/definition') }));
    add('declarationProvider', () => L.registerDeclarationProvider(languageId, { provideDeclaration: this.locationRequest('textDocument/declaration') }));
    add('typeDefinitionProvider', () => L.registerTypeDefinitionProvider(languageId, { provideTypeDefinition: this.locationRequest('textDocument/typeDefinition') }));
    add('implementationProvider', () => L.registerImplementationProvider(languageId, { provideImplementation: this.locationRequest('textDocument/implementation') }));
    add('referencesProvider', () => L.registerReferenceProvider(languageId, this.referenceProvider()));
    add('documentHighlightProvider', () => L.registerDocumentHighlightProvider(languageId, this.documentHighlightProvider()));
    add('documentSymbolProvider', () => L.registerDocumentSymbolProvider(languageId, this.documentSymbolProvider()));
    add('renameProvider', (opts) => L.registerRenameProvider(languageId, this.renameProvider(opts)));
    add('codeActionProvider', (opts) => L.registerCodeActionProvider(languageId, this.codeActionProvider(opts), {
      providedCodeActionKinds: typeof opts === 'object' ? opts.codeActionKinds : undefined,
    }));
    add('documentFormattingProvider', () => L.registerDocumentFormattingEditProvider(languageId, this.formattingProvider()));
    add('documentRangeFormattingProvider', () => L.registerDocumentRangeFormattingEditProvider(languageId, this.rangeFormattingProvider()));
    add('documentOnTypeFormattingProvider', (opts) => L.registerOnTypeFormattingEditProvider(languageId, this.onTypeFormattingProvider(opts)));
    add('inlayHintProvider', (opts) => L.registerInlayHintsProvider(languageId, this.inlayHintsProvider(opts)));
    add('foldingRangeProvider', () => L.registerFoldingRangeProvider(languageId, this.foldingRangeProvider()));
    add('selectionRangeProvider', () => L.registerSelectionRangeProvider(languageId, this.selectionRangeProvider()));
    add('documentLinkProvider', (opts) => L.registerLinkProvider(languageId, this.linkProvider(opts)));
    add('codeLensProvider', (opts) => L.registerCodeLensProvider(languageId, this.codeLensProvider(opts)));
    const semantic = caps.semanticTokensProvider;
    if (semantic && semantic.legend) {
      if (semantic.full) list.push(L.registerDocumentSemanticTokensProvider(languageId, this.semanticTokensProvider(semantic)));
      if (semantic.range) list.push(L.registerDocumentRangeSemanticTokensProvider(languageId, this.rangeSemanticTokensProvider(semantic)));
    }
    this.providers.set(languageId, list);
    // A newly registered pull-diagnostics capability applies to already-open docs.
    if (caps.diagnosticProvider) for (const doc of this.docs.values()) this.schedulePull(doc);
  }

  completionProvider(opts) {
    const options = typeof opts === 'object' ? opts : {};
    return {
      triggerCharacters: options.triggerCharacters || [],
      provideCompletionItems: (model, position, context, token) => this.withDoc(model, 'textDocument/completion', async (doc, textDocument) => {
        const lspContext = { triggerKind: context.triggerKind + 1 }; // Monaco's enum is 0-based, LSP's 1-based
        if (context.triggerCharacter) lspContext.triggerCharacter = context.triggerCharacter;
        const result = await this.request('textDocument/completion', {
          textDocument, position: conv.toLspPosition(position), context: lspContext,
        }, token);
        if (!result || token.isCancellationRequested) return null;
        const list = conv.completionListFrom(result);
        const defaultRange = defaultCompletionRange(model, position);
        const toCommand = (cmd) => this.toMonacoCommand(cmd);
        const suggestions = list.items.map((item) => {
          const suggestion = conv.completionItemToMonaco(item, { defaultRange, itemDefaults: list.itemDefaults, toCommand });
          this.completionSource.set(suggestion, { item, itemDefaults: list.itemDefaults });
          return suggestion;
        });
        return { suggestions, incomplete: list.isIncomplete };
      }),
      resolveCompletionItem: options.resolveProvider ? async (suggestion, token) => {
        const source = this.completionSource.get(suggestion);
        if (!source || this.state !== 'ready') return suggestion;
        try {
          const { item, itemDefaults } = source;
          const data = item.data ?? (itemDefaults && itemDefaults.data);
          const resolved = await this.request('completionItem/resolve', data === undefined ? item : { ...item, data }, token);
          if (!resolved) return suggestion;
          // Resolve may only fill in the lazy fields — the inserted text and range
          // must stay what the user saw.
          const merged = conv.completionItemToMonaco({ ...item, ...resolved }, {
            defaultRange: suggestion.range, itemDefaults, toCommand: (cmd) => this.toMonacoCommand(cmd),
          });
          suggestion.detail = merged.detail ?? suggestion.detail;
          suggestion.documentation = merged.documentation ?? suggestion.documentation;
          suggestion.additionalTextEdits = merged.additionalTextEdits ?? suggestion.additionalTextEdits;
          suggestion.command = merged.command ?? suggestion.command;
        } catch (e) {
          this.logRequestError('completionItem/resolve', e);
        }
        return suggestion;
      } : undefined,
    };
  }

  hoverProvider() {
    return {
      provideHover: (model, position, token) => this.withDoc(model, 'textDocument/hover', async (_doc, textDocument) => {
        const result = await this.request('textDocument/hover', { textDocument, position: conv.toLspPosition(position) }, token);
        if (!result) return null;
        const contents = conv.hoverContentsToMarkdown(result.contents);
        if (!contents.length) return null;
        return {
          contents: contents.map((value) => ({ value })),
          range: result.range ? conv.toMonacoRange(result.range) : undefined,
        };
      }),
    };
  }

  signatureHelpProvider(opts) {
    const options = typeof opts === 'object' ? opts : {};
    return {
      signatureHelpTriggerCharacters: options.triggerCharacters || [],
      signatureHelpRetriggerCharacters: options.retriggerCharacters || [],
      provideSignatureHelp: (model, position, token, context) => this.withDoc(model, 'textDocument/signatureHelp', async (doc, textDocument) => {
        const result = await this.request('textDocument/signatureHelp', {
          textDocument,
          position: conv.toLspPosition(position),
          context: {
            triggerKind: context.triggerKind, // same numbering in Monaco and LSP
            triggerCharacter: context.triggerCharacter,
            isRetrigger: context.isRetrigger,
            activeSignatureHelp: context.isRetrigger && doc.lastSignatureHelp ? doc.lastSignatureHelp : undefined,
          },
        }, token);
        doc.lastSignatureHelp = result;
        const value = conv.signatureHelpToMonaco(result);
        return value ? { value, dispose() {} } : null;
      }),
    };
  }

  locationRequest(method) {
    return (model, position, token) => this.withDoc(model, method, async (_doc, textDocument) => {
      const result = await this.request(method, { textDocument, position: conv.toLspPosition(position) }, token);
      return this.toMonacoLocations(conv.locationsFrom(result));
    });
  }

  referenceProvider() {
    return {
      provideReferences: (model, position, context, token) => this.withDoc(model, 'textDocument/references', async (_doc, textDocument) => {
        const result = await this.request('textDocument/references', {
          textDocument, position: conv.toLspPosition(position), context: { includeDeclaration: !!context.includeDeclaration },
        }, token);
        return this.toMonacoLocations(conv.locationsFrom(result));
      }),
    };
  }

  documentHighlightProvider() {
    return {
      provideDocumentHighlights: (model, position, token) => this.withDoc(model, 'textDocument/documentHighlight', async (_doc, textDocument) => {
        const result = await this.request('textDocument/documentHighlight', { textDocument, position: conv.toLspPosition(position) }, token);
        return (result || []).map((h) => ({ range: conv.toMonacoRange(h.range), kind: conv.highlightKindToMonaco(h.kind) }));
      }),
    };
  }

  documentSymbolProvider() {
    return {
      displayName: this.name,
      provideDocumentSymbols: (model, token) => this.withDoc(model, 'textDocument/documentSymbol', async (_doc, textDocument) => {
        const result = await this.request('textDocument/documentSymbol', { textDocument }, token);
        return conv.documentSymbolsToMonaco(result);
      }),
    };
  }

  renameProvider(opts) {
    const provider = {
      provideRenameEdits: async (model, position, newName, token) => {
        const doc = this.docFor(model);
        if (!doc) return null;
        try {
          const edit = await this.request('textDocument/rename', {
            textDocument: { uri: doc.lspUri }, position: conv.toLspPosition(position), newName,
          }, token);
          return edit ? toMonacoWorkspaceEdit(edit) : { edits: [] };
        } catch (e) {
          return { edits: [], rejectReason: e.message };
        }
      },
    };
    if (typeof opts === 'object' && opts.prepareProvider) {
      provider.resolveRenameLocation = async (model, position, token) => {
        const doc = this.docFor(model);
        if (!doc) return null;
        const word = model.getWordAtPosition(position);
        const wordRange = word && { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
        try {
          const result = await this.request('textDocument/prepareRename', { textDocument: { uri: doc.lspUri }, position: conv.toLspPosition(position) }, token);
          if (!result) return { range: wordRange || new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: "This element can't be renamed." };
          if (result.defaultBehavior) return wordRange ? { range: wordRange, text: word.word } : null;
          const lspRange = result.range || result;
          const monacoRange = conv.toMonacoRange(lspRange);
          return { range: monacoRange, text: result.placeholder ?? model.getValueInRange(monacoRange) };
        } catch (e) {
          return { range: wordRange || new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: e.message };
        }
      };
    }
    return provider;
  }

  codeActionProvider(opts) {
    const resolvable = typeof opts === 'object' && opts.resolveProvider;
    return {
      provideCodeActions: (model, monacoRange, context, token) => this.withDoc(model, 'textDocument/codeAction', async (doc, textDocument) => {
        const lspRange = conv.toLspRange(monacoRange);
        const diagnostics = storedDiagnostics(this.owner, doc.normalized).filter((d) => conv.lspRangesIntersect(d.range, lspRange));
        const result = await this.request('textDocument/codeAction', {
          textDocument,
          range: lspRange,
          context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger },
        }, token);
        const actions = [];
        for (const item of result || []) actions.push(await this.codeActionToMonaco(item));
        return { actions, dispose() {} };
      }),
      resolveCodeAction: resolvable ? async (action, token) => {
        const source = this.codeActionSource.get(action);
        if (!source || action.edit || this.state !== 'ready') return action;
        try {
          const resolved = await this.request('codeAction/resolve', source, token);
          if (resolved && resolved.edit) action.edit = await toMonacoWorkspaceEdit(resolved.edit);
          if (resolved && resolved.command && !action.command) action.command = this.toMonacoCommand(resolved.command);
        } catch (e) {
          this.logRequestError('codeAction/resolve', e);
        }
        return action;
      } : undefined,
    };
  }

  async codeActionToMonaco(item) {
    if (typeof item.command === 'string') return { title: item.title, command: this.toMonacoCommand(item) }; // a bare Command
    const action = {
      title: item.title,
      kind: item.kind,
      isPreferred: item.isPreferred,
      disabled: item.disabled && item.disabled.reason,
      diagnostics: item.diagnostics ? item.diagnostics.map((d) => conv.diagnosticToMarker(d)) : undefined,
      edit: item.edit ? await toMonacoWorkspaceEdit(item.edit) : undefined,
      command: item.command ? this.toMonacoCommand(item.command) : undefined,
    };
    this.codeActionSource.set(action, item);
    return action;
  }

  formattingProvider() {
    return {
      displayName: this.name,
      provideDocumentFormattingEdits: (model, options, token) => this.withDoc(model, 'textDocument/formatting', async (_doc, textDocument) => {
        const edits = await this.request('textDocument/formatting', { textDocument, options: formattingOptions(options) }, token);
        return conv.textEditsToMonaco(edits);
      }),
    };
  }

  rangeFormattingProvider() {
    return {
      displayName: this.name,
      provideDocumentRangeFormattingEdits: (model, monacoRange, options, token) => this.withDoc(model, 'textDocument/rangeFormatting', async (_doc, textDocument) => {
        const edits = await this.request('textDocument/rangeFormatting', {
          textDocument, range: conv.toLspRange(monacoRange), options: formattingOptions(options),
        }, token);
        return conv.textEditsToMonaco(edits);
      }),
    };
  }

  onTypeFormattingProvider(opts) {
    return {
      autoFormatTriggerCharacters: [opts.firstTriggerCharacter, ...(opts.moreTriggerCharacter || [])].filter(Boolean),
      provideOnTypeFormattingEdits: (model, position, ch, options, token) => this.withDoc(model, 'textDocument/onTypeFormatting', async (_doc, textDocument) => {
        const edits = await this.request('textDocument/onTypeFormatting', {
          textDocument, position: conv.toLspPosition(position), ch, options: formattingOptions(options),
        }, token);
        return conv.textEditsToMonaco(edits);
      }),
    };
  }

  inlayHintsProvider(opts) {
    const resolvable = typeof opts === 'object' && opts.resolveProvider;
    const convertOptions = {
      toLocation: (loc) => ({ uri: uriForMarker(loc.uri), range: conv.toMonacoRange(loc.range) }),
      toCommand: (cmd) => this.toMonacoCommand(cmd),
    };
    return {
      displayName: this.name,
      onDidChangeInlayHints: this.inlayHintsChanged.event,
      provideInlayHints: (model, monacoRange, token) => this.withDoc(model, 'textDocument/inlayHint', async (_doc, textDocument) => {
        const result = await this.request('textDocument/inlayHint', { textDocument, range: conv.toLspRange(monacoRange) }, token);
        const hints = (result || []).map((hint) => {
          const converted = conv.inlayHintToMonaco(hint, convertOptions);
          this.inlayHintSource.set(converted, hint);
          return converted;
        });
        return { hints, dispose() {} };
      }),
      resolveInlayHint: resolvable ? async (hint, token) => {
        const source = this.inlayHintSource.get(hint);
        if (!source || this.state !== 'ready') return hint;
        try {
          const resolved = await this.request('inlayHint/resolve', source, token);
          if (resolved) Object.assign(hint, conv.inlayHintToMonaco({ ...source, ...resolved }, convertOptions));
        } catch (e) {
          this.logRequestError('inlayHint/resolve', e);
        }
        return hint;
      } : undefined,
    };
  }

  foldingRangeProvider() {
    const kinds = monaco.languages.FoldingRangeKind;
    const known = { comment: kinds.Comment, imports: kinds.Imports, region: kinds.Region };
    return {
      provideFoldingRanges: (model, _context, token) => this.withDoc(model, 'textDocument/foldingRange', async (_doc, textDocument) => {
        const result = await this.request('textDocument/foldingRange', { textDocument }, token);
        return conv.foldingRangesToMonaco(result).map((r) => ({
          start: r.start, end: r.end, kind: r.kind ? (known[r.kind] || new kinds(r.kind)) : undefined,
        }));
      }),
    };
  }

  selectionRangeProvider() {
    return {
      provideSelectionRanges: (model, positions, token) => this.withDoc(model, 'textDocument/selectionRange', async (_doc, textDocument) => {
        const result = await this.request('textDocument/selectionRange', { textDocument, positions: positions.map(conv.toLspPosition) }, token);
        return conv.selectionRangesToMonaco(result);
      }),
    };
  }

  linkProvider(opts) {
    const resolvable = typeof opts === 'object' && opts.resolveProvider;
    return {
      provideLinks: (model, token) => this.withDoc(model, 'textDocument/documentLink', async (_doc, textDocument) => {
        const result = await this.request('textDocument/documentLink', { textDocument }, token);
        const links = (result || []).map((link) => {
          const converted = { range: conv.toMonacoRange(link.range), url: link.target, tooltip: link.tooltip };
          this.linkSource.set(converted, link);
          return converted;
        });
        return { links };
      }),
      resolveLink: resolvable ? async (link, token) => {
        const source = this.linkSource.get(link);
        if (!source || link.url || this.state !== 'ready') return link;
        try {
          const resolved = await this.request('documentLink/resolve', source, token);
          if (resolved && resolved.target) link.url = resolved.target;
        } catch (e) {
          this.logRequestError('documentLink/resolve', e);
        }
        return link;
      } : undefined,
    };
  }

  codeLensProvider(opts) {
    const resolvable = typeof opts === 'object' && opts.resolveProvider;
    return {
      onDidChange: this.codeLensesChanged.event,
      provideCodeLenses: (model, token) => this.withDoc(model, 'textDocument/codeLens', async (_doc, textDocument) => {
        const result = await this.request('textDocument/codeLens', { textDocument }, token);
        const lenses = [];
        for (const lens of result || []) {
          const converted = { range: conv.toMonacoRange(lens.range), command: await this.toMonacoCommandResolved(lens.command) };
          this.codeLensSource.set(converted, lens);
          lenses.push(converted);
        }
        return { lenses, dispose() {} };
      }),
      resolveCodeLens: resolvable ? async (_model, lens, token) => {
        const source = this.codeLensSource.get(lens);
        if (!source || lens.command || this.state !== 'ready') return lens;
        try {
          const resolved = await this.request('codeLens/resolve', source, token);
          if (resolved && resolved.command) lens.command = await this.toMonacoCommandResolved(resolved.command);
        } catch (e) {
          this.logRequestError('codeLens/resolve', e);
        }
        return lens;
      } : undefined,
    };
  }

  semanticTokensProvider(options) {
    const supportsDelta = typeof options.full === 'object' && options.full.delta;
    return {
      onDidChange: this.semanticTokensChanged.event,
      getLegend: () => options.legend,
      provideDocumentSemanticTokens: (model, lastResultId, token) => this.withDoc(model, 'textDocument/semanticTokens/full', async (_doc, textDocument) => {
        const result = supportsDelta && lastResultId
          ? await this.request('textDocument/semanticTokens/full/delta', { textDocument, previousResultId: lastResultId }, token)
          : await this.request('textDocument/semanticTokens/full', { textDocument }, token);
        if (!result) return null;
        if (Array.isArray(result.edits)) {
          return {
            resultId: result.resultId,
            edits: result.edits.map((e) => ({ start: e.start, deleteCount: e.deleteCount, data: e.data ? new Uint32Array(e.data) : undefined })),
          };
        }
        return { resultId: result.resultId, data: new Uint32Array(result.data || []) };
      }),
      releaseDocumentSemanticTokens: () => {},
    };
  }

  rangeSemanticTokensProvider(options) {
    return {
      getLegend: () => options.legend,
      provideDocumentRangeSemanticTokens: (model, monacoRange, token) => this.withDoc(model, 'textDocument/semanticTokens/range', async (_doc, textDocument) => {
        const result = await this.request('textDocument/semanticTokens/range', { textDocument, range: conv.toLspRange(monacoRange) }, token);
        return result ? { resultId: result.resultId, data: new Uint32Array(result.data || []) } : null;
      }),
    };
  }
}

// Monaco's default completion range: the word before the cursor is replaced on
// insert; with "replace" mode the rest of the word after the cursor goes too.
function defaultCompletionRange(model, position) {
  const before = model.getWordUntilPosition(position);
  const whole = model.getWordAtPosition(position);
  const line = position.lineNumber;
  const insert = { startLineNumber: line, startColumn: before.startColumn, endLineNumber: line, endColumn: position.column };
  const replace = { ...insert, endColumn: whole ? Math.max(whole.endColumn, position.column) : position.column };
  return { insert, replace };
}

// Only the indentation settings: the optional whitespace flags would make some
// formatters rewrite trailing whitespace / final newlines the user never asked for.
function formattingOptions(options) {
  return { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
}
