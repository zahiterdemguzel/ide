// LSP ⇄ Monaco shape conversions — pure, no `monaco` import, so they're unit-tested
// in plain Node (test/lsp-convert.test.mjs). Monaco enums are mirrored here as
// numeric tables (their values are part of Monaco's stable API); anything that
// needs a live Monaco object (a Uri, a FoldingRangeKind) is built by the caller
// from the plain values these return, or passed in as a callback.
//
// Conventions: LSP positions are 0-based {line, character}; Monaco's are 1-based
// {lineNumber, column}. Both count UTF-16 code units, so columns map 1:1.

// ── Positions & ranges ──────────────────────────────────────────────────────

export function toLspPosition(position) {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoPosition(position) {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function toLspRange(range) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function toMonacoRange(range) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function comparePositions(a, b) {
  return a.line - b.line || a.character - b.character;
}

// Touching ranges count as intersecting (a cursor at a diagnostic's end still
// wants that diagnostic's quick fixes).
export function lspRangesIntersect(a, b) {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}

// ── Enum tables ─────────────────────────────────────────────────────────────

// LSP CompletionItemKind (1-based) → monaco.languages.CompletionItemKind.
const MONACO_COMPLETION_KIND = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};
const MONACO_COMPLETION_KIND_PROPERTY = 9;

export function completionKindToMonaco(kind) {
  return MONACO_COMPLETION_KIND[kind] ?? MONACO_COMPLETION_KIND_PROPERTY;
}

// LSP SymbolKind runs File=1 … TypeParameter=26 in the same order as Monaco's
// File=0 … TypeParameter=25.
const MONACO_SYMBOL_KIND_VARIABLE = 12;
export function symbolKindToMonaco(kind) {
  return Number.isInteger(kind) && kind >= 1 && kind <= 26 ? kind - 1 : MONACO_SYMBOL_KIND_VARIABLE;
}

// LSP DiagnosticSeverity Error=1 Warning=2 Information=3 Hint=4 →
// monaco.MarkerSeverity Error=8 Warning=4 Info=2 Hint=1. A missing severity is
// treated as an error, as VS Code does.
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 };
const MONACO_SEVERITY = { 1: MarkerSeverity.Error, 2: MarkerSeverity.Warning, 3: MarkerSeverity.Info, 4: MarkerSeverity.Hint };
export function severityToMonaco(severity) {
  return MONACO_SEVERITY[severity] ?? MarkerSeverity.Error;
}

// LSP DiagnosticTag Unnecessary=1 Deprecated=2 match monaco.MarkerTag exactly.
export function diagnosticTagsToMonaco(tags) {
  return Array.isArray(tags) ? tags.filter((t) => t === 1 || t === 2) : [];
}

// LSP DocumentHighlightKind Text=1 Read=2 Write=3 → Monaco Text=0 Read=1 Write=2.
export function highlightKindToMonaco(kind) {
  return kind === 2 || kind === 3 ? kind - 1 : 0;
}

export const INSERT_AS_SNIPPET = 4; // monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
const LSP_INSERT_FORMAT_SNIPPET = 2;
const LSP_TAG_DEPRECATED = 1; // CompletionItemTag / SymbolTag

// ── Markup ──────────────────────────────────────────────────────────────────

export function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function fenced(language, value) {
  return '```' + (language || '') + '\n' + value + '\n```';
}

// MarkupContent | MarkedString | MarkedString[] → one markdown string.
export function markupToMarkdown(content) {
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(markupToMarkdown).filter(Boolean).join('\n\n');
  if (typeof content === 'string') return content; // a bare MarkedString is markdown
  if (typeof content.kind === 'string') {
    return content.kind === 'markdown' ? String(content.value ?? '') : escapeMarkdown(content.value ?? '');
  }
  if (typeof content.language === 'string') return fenced(content.language, content.value ?? '');
  return '';
}

// Hover contents → the list of markdown blocks Monaco renders separately.
export function hoverContentsToMarkdown(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(markupToMarkdown).filter((s) => s.trim());
}

// Completion / signature documentation → what Monaco's `documentation` takes:
// plain text stays a string, markdown becomes an IMarkdownString.
export function documentationToMonaco(doc) {
  if (doc == null) return undefined;
  if (typeof doc === 'string') return doc || undefined;
  if (doc.kind === 'plaintext') return doc.value || undefined;
  const value = markupToMarkdown(doc);
  return value ? { value } : undefined;
}

// ── URIs ────────────────────────────────────────────────────────────────────
// Servers and Monaco spell the same file differently: `file:///c%3A/x` (VS Code
// style) vs `file:///C:/x`, `%20` vs a literal space, a trailing slash on a folder.
// normalizeUri maps every spelling to one canonical key so a server's URI can be
// matched to the model it means. The key is a lookup key, not a sendable URI.

function decodeSafely(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function fileUriPath(uri) {
  let rest = uri.replace(/^file:/i, '');
  if (rest.startsWith('///')) rest = rest.slice(2); // empty authority: keep the path's leading "/"
  else if (rest.startsWith('//')) rest = '//' + rest.slice(2); // UNC: file://server/share
  let p = decodeSafely(rest).replace(/\\/g, '/');
  p = p.replace(/^\/?([A-Za-z]):/, (_m, drive) => `/${drive.toLowerCase()}:`);
  if (p.length > 1 && p.endsWith('/') && !/^\/[a-z]:\/$/.test(p)) p = p.replace(/\/+$/, '');
  return p;
}

export function normalizeUri(uri) {
  if (typeof uri !== 'string' || !uri) return '';
  if (/^file:/i.test(uri)) return 'file://' + fileUriPath(uri);
  return uri.length > 1 ? uri.replace(/\/+$/, '') : uri;
}

export function sameUri(a, b) {
  return normalizeUri(a) === normalizeUri(b);
}

// Absolute OS path → the file URI sent to servers. Drive letters stay unencoded
// (`file:///c:/x`), which every server accepts; `%3A` trips up a few.
export function pathToUri(fsPath) {
  let p = String(fsPath).replace(/\\/g, '/');
  let authority = '';
  if (p.startsWith('//')) { // UNC path: //server/share/…
    const end = p.indexOf('/', 2);
    authority = end < 0 ? p.slice(2) : p.slice(2, end);
    p = end < 0 ? '/' : p.slice(end);
  }
  p = p.replace(/^\/?([A-Za-z]):/, (_m, drive) => `/${drive.toLowerCase()}:`);
  if (!p.startsWith('/')) p = '/' + p;
  const encoded = p.split('/').map((segment) => (/^[a-z]:$/.test(segment) ? segment : encodeURIComponent(segment))).join('/');
  return `file://${authority}${encoded}`;
}

// File URI → absolute OS path (Windows paths get backslashes and an upper-case drive).
export function uriToPath(uri) {
  if (!/^file:/i.test(uri || '')) return null;
  const p = fileUriPath(uri);
  const drive = /^\/([a-z]):(\/.*)?$/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] || '/').replace(/\//g, '\\')}`;
  if (p.startsWith('//')) return p.replace(/\//g, '\\');
  return p;
}

// ── Edits ───────────────────────────────────────────────────────────────────

export function textEditToMonaco(edit) {
  // InsertReplaceEdit (completion) carries insert/replace instead of range.
  const range = edit.range || edit.replace || edit.insert;
  return { range: toMonacoRange(range), text: edit.newText ?? '' };
}

export function textEditsToMonaco(edits) {
  return Array.isArray(edits) ? edits.map(textEditToMonaco) : [];
}

// WorkspaceEdit (`changes` and/or `documentChanges`) → one entry per document, in
// the order the server listed them. Create/rename/delete file operations are not
// applied (the client advertises no resourceOperations) but are returned so the
// caller can report them.
export function workspaceEditEntries(edit) {
  const byUri = new Map();
  const fileOperations = [];
  const add = (uri, edits, version) => {
    const key = normalizeUri(uri);
    if (!byUri.has(key)) byUri.set(key, { uri, version: version ?? null, edits: [] });
    byUri.get(key).edits.push(...textEditsToMonaco(edits));
  };
  if (edit && Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (change && change.kind) fileOperations.push(change);
      else if (change && change.textDocument) add(change.textDocument.uri, change.edits, change.textDocument.version);
    }
  } else if (edit && edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits, null);
  }
  return { entries: [...byUri.values()], fileOperations };
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

// LSP Diagnostic → monaco.editor.IMarkerData. `toUri` turns a URI string into a
// monaco.Uri for the clickable code link and related-information entries; without
// it those are left out (tests run without Monaco).
export function diagnosticToMarker(diagnostic, toUri) {
  const range = toMonacoRange(diagnostic.range);
  const marker = {
    severity: severityToMonaco(diagnostic.severity),
    message: diagnostic.message || '',
    ...range,
    source: diagnostic.source || undefined,
    tags: diagnosticTagsToMonaco(diagnostic.tags),
  };
  if (diagnostic.code != null && diagnostic.code !== '') {
    const href = diagnostic.codeDescription && diagnostic.codeDescription.href;
    marker.code = href && toUri ? { value: String(diagnostic.code), target: toUri(href) } : String(diagnostic.code);
  }
  if (toUri && Array.isArray(diagnostic.relatedInformation)) {
    marker.relatedInformation = diagnostic.relatedInformation.map((info) => ({
      resource: toUri(info.location.uri),
      message: info.message,
      ...toMonacoRange(info.location.range),
    }));
  }
  return marker;
}

// ── Completion ──────────────────────────────────────────────────────────────

// CompletionItem[] | CompletionList | null → a uniform list.
export function completionListFrom(result) {
  if (!result) return { items: [], isIncomplete: false, itemDefaults: null };
  if (Array.isArray(result)) return { items: result, isIncomplete: false, itemDefaults: null };
  return { items: result.items || [], isIncomplete: !!result.isIncomplete, itemDefaults: result.itemDefaults || null };
}

function completionRange(item, defaults, defaultRange) {
  const edit = item.textEdit;
  if (edit && edit.insert && edit.replace) return { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
  if (edit && edit.range) return toMonacoRange(edit.range);
  const editRange = defaults && defaults.editRange;
  if (editRange && editRange.insert) return { insert: toMonacoRange(editRange.insert), replace: toMonacoRange(editRange.replace) };
  if (editRange && editRange.start) return toMonacoRange(editRange);
  return defaultRange;
}

// LSP CompletionItem → monaco.languages.CompletionItem. `defaultRange` (Monaco
// shape) is used when neither the item nor the list defaults carry an edit range;
// `toCommand` converts the item's LSP Command, if any.
export function completionItemToMonaco(item, { defaultRange, itemDefaults = null, toCommand = null } = {}) {
  const insertTextFormat = item.insertTextFormat ?? (itemDefaults && itemDefaults.insertTextFormat);
  // With a list-default edit range, `textEditText` (LSP 3.17) outranks insertText.
  const usesDefaultRange = !item.textEdit && itemDefaults && itemDefaults.editRange;
  const text = item.textEdit
    ? item.textEdit.newText
    : (usesDefaultRange && item.textEditText != null ? item.textEditText : (item.insertText ?? item.label));
  const label = item.labelDetails
    ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
    : item.label;
  const deprecated = item.deprecated || (Array.isArray(item.tags) && item.tags.includes(LSP_TAG_DEPRECATED));
  const commitCharacters = item.commitCharacters || (itemDefaults && itemDefaults.commitCharacters);
  return {
    label,
    kind: completionKindToMonaco(item.kind),
    tags: deprecated ? [1] : undefined,
    detail: item.detail || undefined,
    documentation: documentationToMonaco(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect || undefined,
    insertText: text ?? '',
    insertTextRules: insertTextFormat === LSP_INSERT_FORMAT_SNIPPET ? INSERT_AS_SNIPPET : undefined,
    range: completionRange(item, itemDefaults, defaultRange),
    commitCharacters: commitCharacters || undefined,
    additionalTextEdits: item.additionalTextEdits ? textEditsToMonaco(item.additionalTextEdits) : undefined,
    command: item.command && toCommand ? toCommand(item.command) : undefined,
  };
}

// ── Signature help ──────────────────────────────────────────────────────────

export function signatureHelpToMonaco(help) {
  if (!help || !Array.isArray(help.signatures) || !help.signatures.length) return null;
  return {
    signatures: help.signatures.map((sig) => ({
      label: sig.label,
      documentation: documentationToMonaco(sig.documentation),
      parameters: (sig.parameters || []).map((p) => ({ label: p.label, documentation: documentationToMonaco(p.documentation) })),
      activeParameter: sig.activeParameter,
    })),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}

// ── Symbols ─────────────────────────────────────────────────────────────────

function symbolTags(symbol) {
  return symbol.deprecated || (Array.isArray(symbol.tags) && symbol.tags.includes(LSP_TAG_DEPRECATED)) ? [1] : [];
}

function documentSymbolToMonaco(symbol) {
  return {
    name: symbol.name,
    detail: symbol.detail || '',
    kind: symbolKindToMonaco(symbol.kind),
    tags: symbolTags(symbol),
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange || symbol.range),
    children: (symbol.children || []).map(documentSymbolToMonaco),
  };
}

// DocumentSymbol[] (a tree) or SymbolInformation[] (flat, with locations) →
// Monaco DocumentSymbol tree. Flat results are nested by range containment so
// breadcrumbs/outline still get a hierarchy.
export function documentSymbolsToMonaco(result) {
  if (!Array.isArray(result) || !result.length) return [];
  if (!result[0].location) return result.map(documentSymbolToMonaco);
  const flat = result
    .map((info) => ({
      name: info.name,
      detail: info.containerName || '',
      kind: symbolKindToMonaco(info.kind),
      tags: symbolTags(info),
      range: toMonacoRange(info.location.range),
      selectionRange: toMonacoRange(info.location.range),
      children: [],
    }))
    .sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn
      || b.range.endLineNumber - a.range.endLineNumber || b.range.endColumn - a.range.endColumn);
  const roots = [];
  const stack = [];
  for (const symbol of flat) {
    while (stack.length && !monacoRangeContains(stack[stack.length - 1].range, symbol.range)) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(symbol);
    stack.push(symbol);
  }
  return roots;
}

function monacoRangeContains(outer, inner) {
  const startsAfter = inner.startLineNumber > outer.startLineNumber
    || (inner.startLineNumber === outer.startLineNumber && inner.startColumn >= outer.startColumn);
  const endsBefore = inner.endLineNumber < outer.endLineNumber
    || (inner.endLineNumber === outer.endLineNumber && inner.endColumn <= outer.endColumn);
  return startsAfter && endsBefore;
}

// SymbolInformation | WorkspaceSymbol → a plain row; a WorkspaceSymbol may carry
// only a URI (range resolved lazily by the server), so the range can be null.
export function workspaceSymbolToPlain(symbol) {
  const location = symbol.location || {};
  return {
    name: symbol.name,
    kind: symbolKindToMonaco(symbol.kind),
    containerName: symbol.containerName || '',
    uri: location.uri || '',
    range: location.range ? toMonacoRange(location.range) : null,
  };
}

// ── Locations ───────────────────────────────────────────────────────────────

// Location | Location[] | LocationLink[] | null → [{uri, range, targetSelectionRange?,
// originSelectionRange?}] with Monaco-shaped ranges and the server's URI strings.
export function locationsFrom(result) {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.filter(Boolean).map((loc) => {
    if (loc.targetUri) {
      return {
        uri: loc.targetUri,
        range: toMonacoRange(loc.targetRange),
        targetSelectionRange: toMonacoRange(loc.targetSelectionRange || loc.targetRange),
        originSelectionRange: loc.originSelectionRange ? toMonacoRange(loc.originSelectionRange) : undefined,
      };
    }
    return { uri: loc.uri, range: toMonacoRange(loc.range) };
  });
}

// ── Folding & selection ranges ──────────────────────────────────────────────

// Monaco lines are 1-based and both ends are inclusive, like LSP's. `kind` stays a
// string ('comment' | 'imports' | 'region' | custom); the caller makes the
// FoldingRangeKind. Single-line ranges fold nothing and are dropped.
export function foldingRangesToMonaco(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter((r) => r.endLine > r.startLine)
    .map((r) => ({ start: r.startLine + 1, end: r.endLine + 1, kind: r.kind }));
}

// SelectionRange[] (each a linked list innermost → outermost via `parent`) →
// Monaco's per-position arrays of {range}.
export function selectionRangesToMonaco(result) {
  if (!Array.isArray(result)) return [];
  return result.map((node) => {
    const chain = [];
    for (let n = node; n; n = n.parent) chain.push({ range: toMonacoRange(n.range) });
    return chain;
  });
}

// ── Inlay hints ─────────────────────────────────────────────────────────────

// `toLocation({uri, range})` and `toCommand(cmd)` build the Monaco objects for a
// clickable label part; both are optional.
export function inlayHintToMonaco(hint, { toLocation = null, toCommand = null } = {}) {
  const label = typeof hint.label === 'string'
    ? hint.label
    : hint.label.map((part) => ({
      label: part.value,
      tooltip: tooltipToMonaco(part.tooltip),
      location: part.location && toLocation ? toLocation(part.location) : undefined,
      command: part.command && toCommand ? toCommand(part.command) : undefined,
    }));
  return {
    label,
    position: toMonacoPosition(hint.position),
    kind: hint.kind === 1 || hint.kind === 2 ? hint.kind : undefined,
    tooltip: tooltipToMonaco(hint.tooltip),
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
    textEdits: hint.textEdits ? textEditsToMonaco(hint.textEdits) : undefined,
  };
}

function tooltipToMonaco(tooltip) {
  if (tooltip == null) return undefined;
  if (typeof tooltip === 'string') return tooltip;
  return documentationToMonaco(tooltip);
}

// ── Document sync ───────────────────────────────────────────────────────────

// ServerCapabilities.textDocumentSync (a number or an options object) →
// { change: 0 none | 1 full | 2 incremental, openClose, save: {includeText}|null }.
export function textSyncOptions(sync) {
  if (typeof sync === 'number') return { change: sync, openClose: sync !== 0, save: null };
  if (!sync) return { change: 0, openClose: false, save: null };
  const save = sync.save ? { includeText: !!(typeof sync.save === 'object' && sync.save.includeText) } : null;
  return { change: sync.change ?? 0, openClose: !!sync.openClose, save };
}

// Monaco IModelContentChange[] → LSP TextDocumentContentChangeEvent[]. Monaco
// orders a multi-cursor edit's changes so applying them one after another is
// correct, which is also how LSP applies contentChanges.
export function contentChangesToLsp(changes) {
  return changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }));
}

// Monaco language id (+ file path) → the LSP languageId servers expect. JSX/TSX
// share Monaco's javascript/typescript ids but servers want the react variants.
const LSP_LANGUAGE_ID = { shell: 'shellscript', 'objective-cpp': 'objective-cpp', hcl: 'terraform' };
export function lspLanguageId(monacoLanguageId, filePath = '') {
  const ext = /\.([^./\\]+)$/.exec(filePath || '');
  const extension = ext ? ext[1].toLowerCase() : '';
  if (monacoLanguageId === 'typescript' && extension === 'tsx') return 'typescriptreact';
  if (monacoLanguageId === 'javascript' && extension === 'jsx') return 'javascriptreact';
  return LSP_LANGUAGE_ID[monacoLanguageId] || monacoLanguageId;
}

// ── Configuration ───────────────────────────────────────────────────────────

// `workspace/configuration` lookup: dotted `section` into the nested settings
// object (whole object when no section). Unknown sections answer null, which
// servers read as "use your defaults".
export function configurationSection(settings, section) {
  if (!section) return settings || {};
  let node = settings;
  for (const part of section.split('.')) {
    if (node == null || typeof node !== 'object' || !(part in node)) return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}

// ── Dynamic registration ────────────────────────────────────────────────────
// `client/registerCapability` method → the ServerCapabilities key it stands for,
// so a dynamically registered feature can be folded into the static capabilities
// and providers registered from one merged view.
export const CAPABILITY_FOR_METHOD = {
  'textDocument/completion': 'completionProvider',
  'textDocument/hover': 'hoverProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/declaration': 'declarationProvider',
  'textDocument/typeDefinition': 'typeDefinitionProvider',
  'textDocument/implementation': 'implementationProvider',
  'textDocument/references': 'referencesProvider',
  'textDocument/documentHighlight': 'documentHighlightProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/codeAction': 'codeActionProvider',
  'textDocument/codeLens': 'codeLensProvider',
  'textDocument/documentLink': 'documentLinkProvider',
  'textDocument/formatting': 'documentFormattingProvider',
  'textDocument/rangeFormatting': 'documentRangeFormattingProvider',
  'textDocument/onTypeFormatting': 'documentOnTypeFormattingProvider',
  'textDocument/rename': 'renameProvider',
  'textDocument/foldingRange': 'foldingRangeProvider',
  'textDocument/selectionRange': 'selectionRangeProvider',
  'textDocument/semanticTokens': 'semanticTokensProvider',
  'textDocument/inlayHint': 'inlayHintProvider',
  'textDocument/diagnostic': 'diagnosticProvider',
  'workspace/symbol': 'workspaceSymbolProvider',
  'workspace/executeCommand': 'executeCommandProvider',
};

// Static capabilities + live registrations (Map id → {method, registerOptions}) →
// the effective capabilities. A registration with no options means "supported".
export function effectiveCapabilities(staticCapabilities, registrations) {
  const merged = { ...(staticCapabilities || {}) };
  for (const { method, registerOptions } of registrations.values()) {
    const key = CAPABILITY_FOR_METHOD[method];
    if (!key) continue;
    merged[key] = registerOptions && typeof registerOptions === 'object' ? { ...registerOptions } : true;
  }
  return merged;
}
