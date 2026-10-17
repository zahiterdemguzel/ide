import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as conv from '../src/renderer/editor/lsp-convert.js';

const lspRange = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
const monacoRange = (sl, sc, el, ec) => ({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec });

// --- positions & ranges ---

test('positions and ranges: LSP 0-based ⇄ Monaco 1-based, round trip', () => {
  assert.deepEqual(conv.toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(conv.toMonacoPosition({ line: 4, character: 2 }), { lineNumber: 5, column: 3 });
  assert.deepEqual(conv.toMonacoRange(lspRange(0, 0, 2, 5)), monacoRange(1, 1, 3, 6));
  assert.deepEqual(conv.toLspRange(conv.toMonacoRange(lspRange(3, 1, 3, 9))), lspRange(3, 1, 3, 9));
});

test('lspRangesIntersect: overlapping and touching ranges intersect, disjoint ones do not', () => {
  assert.ok(conv.lspRangesIntersect(lspRange(1, 0, 1, 5), lspRange(1, 3, 1, 8)));
  assert.ok(conv.lspRangesIntersect(lspRange(1, 0, 1, 5), lspRange(1, 5, 1, 5)));
  assert.ok(!conv.lspRangesIntersect(lspRange(1, 0, 1, 5), lspRange(2, 0, 2, 1)));
});

// --- enums ---

test('completionKindToMonaco: maps the LSP kinds that differ in order', () => {
  assert.equal(conv.completionKindToMonaco(1), 18); // Text
  assert.equal(conv.completionKindToMonaco(2), 0); // Method
  assert.equal(conv.completionKindToMonaco(3), 1); // Function
  assert.equal(conv.completionKindToMonaco(14), 17); // Keyword
  assert.equal(conv.completionKindToMonaco(15), 28); // Snippet
  assert.equal(conv.completionKindToMonaco(25), 24); // TypeParameter
  assert.equal(conv.completionKindToMonaco(undefined), 9); // falls back to Property
});

test('symbolKindToMonaco / severityToMonaco / highlightKindToMonaco / tags', () => {
  assert.equal(conv.symbolKindToMonaco(1), 0); // File
  assert.equal(conv.symbolKindToMonaco(5), 4); // Class
  assert.equal(conv.symbolKindToMonaco(26), 25); // TypeParameter
  assert.equal(conv.symbolKindToMonaco(99), 12); // unknown → Variable
  assert.equal(conv.severityToMonaco(1), 8);
  assert.equal(conv.severityToMonaco(2), 4);
  assert.equal(conv.severityToMonaco(3), 2);
  assert.equal(conv.severityToMonaco(4), 1);
  assert.equal(conv.severityToMonaco(undefined), 8);
  assert.equal(conv.highlightKindToMonaco(1), 0);
  assert.equal(conv.highlightKindToMonaco(3), 2);
  assert.equal(conv.highlightKindToMonaco(undefined), 0);
  assert.deepEqual(conv.diagnosticTagsToMonaco([1, 2, 7]), [1, 2]);
  assert.deepEqual(conv.diagnosticTagsToMonaco(undefined), []);
});

// --- markup ---

test('markupToMarkdown: MarkupContent, MarkedString and arrays', () => {
  assert.equal(conv.markupToMarkdown({ kind: 'markdown', value: '**x**' }), '**x**');
  assert.equal(conv.markupToMarkdown({ kind: 'plaintext', value: 'a_b*c' }), 'a\\_b\\*c');
  assert.equal(conv.markupToMarkdown('plain *md*'), 'plain *md*');
  assert.equal(conv.markupToMarkdown({ language: 'python', value: 'def f(): ...' }), '```python\ndef f(): ...\n```');
  assert.equal(conv.markupToMarkdown([{ language: 'ts', value: 'x' }, 'doc']), '```ts\nx\n```\n\ndoc');
  assert.equal(conv.markupToMarkdown(null), '');
});

test('hoverContentsToMarkdown: drops empty blocks; documentationToMonaco keeps plaintext as a string', () => {
  assert.deepEqual(conv.hoverContentsToMarkdown(['', { language: 'go', value: 'func f()' }]), ['```go\nfunc f()\n```']);
  assert.deepEqual(conv.hoverContentsToMarkdown({ kind: 'markdown', value: '  ' }), []);
  assert.equal(conv.documentationToMonaco({ kind: 'plaintext', value: 'hi' }), 'hi');
  assert.deepEqual(conv.documentationToMonaco({ kind: 'markdown', value: '# hi' }), { value: '# hi' });
  assert.equal(conv.documentationToMonaco(undefined), undefined);
});

// --- URIs ---

test('normalizeUri: every spelling of a Windows file matches', () => {
  const key = conv.normalizeUri('file:///c:/Users/me/a.py');
  assert.equal(conv.normalizeUri('file:///C:/Users/me/a.py'), key);
  assert.equal(conv.normalizeUri('file:///c%3A/Users/me/a.py'), key);
  assert.equal(conv.normalizeUri('file:///C%3a/Users/me/a.py'), key);
  assert.ok(conv.sameUri('file:///c%3A/Users/me/a.py', 'file:///C:/Users/me/a.py'));
});

test('normalizeUri: percent-encoding and trailing slashes do not matter; case of the path does', () => {
  assert.equal(conv.normalizeUri('file:///Users/me/my%20proj/'), conv.normalizeUri('file:///Users/me/my proj'));
  assert.equal(conv.normalizeUri('file:///a/%C3%A7.ts'), conv.normalizeUri('file:///a/ç.ts'));
  assert.notEqual(conv.normalizeUri('file:///a/B.ts'), conv.normalizeUri('file:///a/b.ts'));
  assert.equal(conv.normalizeUri('file:///'), 'file:///');
  assert.equal(conv.normalizeUri('untitled:Untitled-1'), 'untitled:Untitled-1');
  assert.equal(conv.normalizeUri(undefined), '');
});

test('pathToUri / uriToPath: POSIX, Windows, spaces, UNC', () => {
  assert.equal(conv.pathToUri('/Users/me/my proj/a#1.ts'), 'file:///Users/me/my%20proj/a%231.ts');
  assert.equal(conv.pathToUri('C:\\Users\\me\\a.py'), 'file:///c:/Users/me/a.py');
  assert.equal(conv.pathToUri('\\\\server\\share\\x.c'), 'file://server/share/x.c');
  assert.equal(conv.uriToPath('file:///Users/me/my%20proj/a%231.ts'), '/Users/me/my proj/a#1.ts');
  assert.equal(conv.uriToPath('file:///c%3A/Users/me/a.py'), 'C:\\Users\\me\\a.py');
  assert.equal(conv.uriToPath('https://example.com'), null);
  for (const p of ['/tmp/a b/ç.py', 'C:\\x\\y z.ts']) assert.equal(conv.uriToPath(conv.pathToUri(p)), p);
});

// --- edits ---

test('textEditToMonaco: TextEdit and InsertReplaceEdit', () => {
  assert.deepEqual(conv.textEditToMonaco({ range: lspRange(0, 0, 0, 3), newText: 'foo' }), { range: monacoRange(1, 1, 1, 4), text: 'foo' });
  assert.deepEqual(conv.textEditToMonaco({ insert: lspRange(0, 0, 0, 1), replace: lspRange(0, 0, 0, 3), newText: 'x' }).range, monacoRange(1, 1, 1, 4));
});

test('workspaceEditEntries: `changes` form', () => {
  const { entries, fileOperations } = conv.workspaceEditEntries({
    changes: { 'file:///a.ts': [{ range: lspRange(0, 0, 0, 1), newText: 'x' }], 'file:///b.ts': [] },
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].uri, 'file:///a.ts');
  assert.deepEqual(entries[0].edits, [{ range: monacoRange(1, 1, 1, 2), text: 'x' }]);
  assert.deepEqual(fileOperations, []);
});

test('workspaceEditEntries: `documentChanges` wins, merges same-file edits across spellings, reports file ops', () => {
  const { entries, fileOperations } = conv.workspaceEditEntries({
    changes: { 'file:///ignored.ts': [{ range: lspRange(0, 0, 0, 0), newText: 'no' }] },
    documentChanges: [
      { textDocument: { uri: 'file:///c%3A/a.ts', version: 3 }, edits: [{ range: lspRange(0, 0, 0, 1), newText: 'x' }] },
      { kind: 'rename', oldUri: 'file:///c:/a.ts', newUri: 'file:///c:/b.ts' },
      { textDocument: { uri: 'file:///C:/a.ts', version: 3 }, edits: [{ range: lspRange(1, 0, 1, 1), newText: 'y' }] },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, 3);
  assert.equal(entries[0].edits.length, 2);
  assert.equal(fileOperations.length, 1);
});

// --- diagnostics ---

test('diagnosticToMarker: severity, range, tags, code (with link when a Uri maker is given), related info', () => {
  const diagnostic = {
    range: lspRange(2, 4, 2, 9), severity: 2, message: 'unused', source: 'Pyright', tags: [1], code: 'reportUnused',
    codeDescription: { href: 'https://docs/x' },
    relatedInformation: [{ location: { uri: 'file:///a.py', range: lspRange(0, 0, 0, 1) }, message: 'here' }],
  };
  const plain = conv.diagnosticToMarker(diagnostic);
  assert.equal(plain.severity, conv.MarkerSeverity.Warning);
  assert.equal(plain.startLineNumber, 3);
  assert.equal(plain.startColumn, 5);
  assert.equal(plain.code, 'reportUnused');
  assert.deepEqual(plain.tags, [1]);
  assert.equal(plain.relatedInformation, undefined);
  const linked = conv.diagnosticToMarker(diagnostic, (u) => ({ uri: u }));
  assert.deepEqual(linked.code, { value: 'reportUnused', target: { uri: 'https://docs/x' } });
  assert.equal(linked.relatedInformation[0].message, 'here');
  assert.deepEqual(linked.relatedInformation[0].resource, { uri: 'file:///a.py' });
  assert.equal(conv.diagnosticToMarker({ range: lspRange(0, 0, 0, 0), message: 'm', code: 0 }).code, '0');
});

// --- completion ---

test('completionListFrom: array, list and null', () => {
  assert.deepEqual(conv.completionListFrom(null).items, []);
  assert.equal(conv.completionListFrom([{ label: 'a' }]).items.length, 1);
  const list = conv.completionListFrom({ isIncomplete: true, items: [{ label: 'a' }], itemDefaults: { commitCharacters: ['.'] } });
  assert.equal(list.isIncomplete, true);
  assert.deepEqual(list.itemDefaults.commitCharacters, ['.']);
});

test('completionItemToMonaco: snippet rule, label details, deprecation, edits, default range', () => {
  const defaultRange = monacoRange(1, 1, 1, 3);
  const item = conv.completionItemToMonaco({
    label: 'print', kind: 3, insertText: 'print($1)', insertTextFormat: 2, tags: [1],
    labelDetails: { detail: '(x)', description: 'builtins' },
    documentation: { kind: 'markdown', value: 'Prints.' },
    additionalTextEdits: [{ range: lspRange(0, 0, 0, 0), newText: 'import x\n' }],
    command: { title: 'retrigger', command: 'editor.action.triggerParameterHints' },
  }, { defaultRange, toCommand: (c) => ({ id: c.command, title: c.title }) });
  assert.equal(item.insertText, 'print($1)');
  assert.equal(item.insertTextRules, conv.INSERT_AS_SNIPPET);
  assert.equal(item.kind, 1);
  assert.deepEqual(item.label, { label: 'print', detail: '(x)', description: 'builtins' });
  assert.deepEqual(item.tags, [1]);
  assert.deepEqual(item.documentation, { value: 'Prints.' });
  assert.equal(item.range, defaultRange);
  assert.equal(item.additionalTextEdits[0].text, 'import x\n');
  assert.equal(item.command.id, 'editor.action.triggerParameterHints');
});

test('completionItemToMonaco: textEdit (plain and insert/replace) and list itemDefaults', () => {
  const plain = conv.completionItemToMonaco({ label: 'foo', textEdit: { range: lspRange(0, 2, 0, 4), newText: 'foobar' } }, {});
  assert.equal(plain.insertText, 'foobar');
  assert.deepEqual(plain.range, monacoRange(1, 3, 1, 5));
  const ir = conv.completionItemToMonaco({ label: 'x', textEdit: { insert: lspRange(0, 0, 0, 1), replace: lspRange(0, 0, 0, 3), newText: 'x' } }, {});
  assert.deepEqual(ir.range, { insert: monacoRange(1, 1, 1, 2), replace: monacoRange(1, 1, 1, 4) });
  const itemDefaults = { editRange: lspRange(0, 1, 0, 2), insertTextFormat: 2, commitCharacters: ['('] };
  const defaulted = conv.completionItemToMonaco({ label: 'lbl', textEditText: 'fn($0)' }, { itemDefaults });
  assert.equal(defaulted.insertText, 'fn($0)');
  assert.deepEqual(defaulted.range, monacoRange(1, 2, 1, 3));
  assert.equal(defaulted.insertTextRules, conv.INSERT_AS_SNIPPET);
  assert.deepEqual(defaulted.commitCharacters, ['(']);
  assert.equal(conv.completionItemToMonaco({ label: 'bare' }, {}).insertText, 'bare');
});

// --- signature help, symbols, locations ---

test('signatureHelpToMonaco: documentation conversion and empty results', () => {
  assert.equal(conv.signatureHelpToMonaco(null), null);
  assert.equal(conv.signatureHelpToMonaco({ signatures: [] }), null);
  const help = conv.signatureHelpToMonaco({
    signatures: [{ label: 'f(a, b)', documentation: 'doc', parameters: [{ label: [2, 3], documentation: { kind: 'markdown', value: '*a*' } }] }],
    activeParameter: 1,
  });
  assert.equal(help.activeSignature, 0);
  assert.equal(help.activeParameter, 1);
  assert.deepEqual(help.signatures[0].parameters[0], { label: [2, 3], documentation: { value: '*a*' } });
});

test('documentSymbolsToMonaco: hierarchical DocumentSymbol tree', () => {
  const [cls] = conv.documentSymbolsToMonaco([{
    name: 'A', kind: 5, range: lspRange(0, 0, 9, 0), selectionRange: lspRange(0, 6, 0, 7),
    children: [{ name: 'm', kind: 6, detail: '()', range: lspRange(1, 2, 2, 0), selectionRange: lspRange(1, 6, 1, 7), tags: [1] }],
  }]);
  assert.equal(cls.kind, 4);
  assert.equal(cls.detail, '');
  assert.deepEqual(cls.tags, []);
  assert.deepEqual(cls.selectionRange, monacoRange(1, 7, 1, 8));
  assert.equal(cls.children[0].kind, 5);
  assert.deepEqual(cls.children[0].tags, [1]);
});

test('documentSymbolsToMonaco: flat SymbolInformation nested by containment', () => {
  const loc = (r) => ({ uri: 'file:///a.py', range: r });
  const roots = conv.documentSymbolsToMonaco([
    { name: 'method', kind: 6, location: loc(lspRange(1, 2, 3, 0)), containerName: 'Cls' },
    { name: 'Cls', kind: 5, location: loc(lspRange(0, 0, 5, 0)) },
    { name: 'fn', kind: 12, location: loc(lspRange(6, 0, 8, 0)) },
  ]);
  assert.deepEqual(roots.map((s) => s.name), ['Cls', 'fn']);
  assert.deepEqual(roots[0].children.map((s) => s.name), ['method']);
  assert.equal(roots[0].children[0].detail, 'Cls');
});

test('workspaceSymbolToPlain: with and without a range', () => {
  const full = conv.workspaceSymbolToPlain({ name: 'X', kind: 5, containerName: 'mod', location: { uri: 'file:///x.py', range: lspRange(0, 0, 0, 1) } });
  assert.deepEqual(full, { name: 'X', kind: 4, containerName: 'mod', uri: 'file:///x.py', range: monacoRange(1, 1, 1, 2) });
  assert.equal(conv.workspaceSymbolToPlain({ name: 'Y', kind: 12, location: { uri: 'file:///y.py' } }).range, null);
});

test('locationsFrom: Location, Location[], LocationLink[] and null', () => {
  assert.deepEqual(conv.locationsFrom(null), []);
  assert.deepEqual(conv.locationsFrom({ uri: 'file:///a', range: lspRange(0, 0, 0, 1) }), [{ uri: 'file:///a', range: monacoRange(1, 1, 1, 2) }]);
  const [link] = conv.locationsFrom([{
    targetUri: 'file:///b', targetRange: lspRange(0, 0, 4, 0), targetSelectionRange: lspRange(0, 4, 0, 5), originSelectionRange: lspRange(9, 0, 9, 3),
  }]);
  assert.equal(link.uri, 'file:///b');
  assert.deepEqual(link.range, monacoRange(1, 1, 5, 1));
  assert.deepEqual(link.targetSelectionRange, monacoRange(1, 5, 1, 6));
  assert.deepEqual(link.originSelectionRange, monacoRange(10, 1, 10, 4));
});

// --- folding, selection, inlay hints ---

test('foldingRangesToMonaco: 1-based inclusive lines, kind kept, single-line ranges dropped', () => {
  assert.deepEqual(conv.foldingRangesToMonaco([
    { startLine: 0, endLine: 4, kind: 'imports' }, { startLine: 3, endLine: 3 }, { startLine: 5, endLine: 9 },
  ]), [{ start: 1, end: 5, kind: 'imports' }, { start: 6, end: 10, kind: undefined }]);
  assert.deepEqual(conv.foldingRangesToMonaco(null), []);
});

test('selectionRangesToMonaco: each linked list flattened innermost → outermost', () => {
  const result = conv.selectionRangesToMonaco([{ range: lspRange(0, 4, 0, 7), parent: { range: lspRange(0, 0, 0, 20) } }]);
  assert.deepEqual(result, [[{ range: monacoRange(1, 5, 1, 8) }, { range: monacoRange(1, 1, 1, 21) }]]);
});

test('inlayHintToMonaco: string and part labels, kind, padding', () => {
  const simple = conv.inlayHintToMonaco({ position: { line: 0, character: 5 }, label: ': int', kind: 1, paddingLeft: true });
  assert.deepEqual(simple.position, { lineNumber: 1, column: 6 });
  assert.equal(simple.label, ': int');
  assert.equal(simple.kind, 1);
  assert.equal(simple.paddingLeft, true);
  const parts = conv.inlayHintToMonaco(
    { position: { line: 1, character: 0 }, label: [{ value: 'name:', tooltip: { kind: 'markdown', value: 'p' }, location: { uri: 'file:///a', range: lspRange(0, 0, 0, 1) } }], kind: 9 },
    { toLocation: (l) => ({ resolved: l.uri }) },
  );
  assert.equal(parts.kind, undefined);
  assert.deepEqual(parts.label[0], { label: 'name:', tooltip: { value: 'p' }, location: { resolved: 'file:///a' }, command: undefined });
});

// --- document sync & language ids ---

test('textSyncOptions: number and object forms', () => {
  assert.deepEqual(conv.textSyncOptions(2), { change: 2, openClose: true, save: null });
  assert.deepEqual(conv.textSyncOptions(undefined), { change: 0, openClose: false, save: null });
  assert.deepEqual(conv.textSyncOptions({ openClose: true, change: 1, save: { includeText: true } }), { change: 1, openClose: true, save: { includeText: true } });
  assert.deepEqual(conv.textSyncOptions({ change: 2, save: true }).save, { includeText: false });
});

test('contentChangesToLsp: Monaco change events become ranged LSP changes in order', () => {
  const changes = [
    { range: monacoRange(3, 1, 3, 1), rangeLength: 0, text: 'b' },
    { range: monacoRange(1, 1, 1, 4), rangeLength: 3, text: 'a' },
  ];
  assert.deepEqual(conv.contentChangesToLsp(changes), [
    { range: lspRange(2, 0, 2, 0), rangeLength: 0, text: 'b' },
    { range: lspRange(0, 0, 0, 3), rangeLength: 3, text: 'a' },
  ]);
});

test('lspLanguageId: react variants by extension, shell → shellscript', () => {
  assert.equal(conv.lspLanguageId('typescript', '/a/App.tsx'), 'typescriptreact');
  assert.equal(conv.lspLanguageId('javascript', 'C:\\a\\App.JSX'), 'javascriptreact');
  assert.equal(conv.lspLanguageId('typescript', '/a/x.ts'), 'typescript');
  assert.equal(conv.lspLanguageId('shell', '/a/run.sh'), 'shellscript');
  assert.equal(conv.lspLanguageId('python', '/a/x.py'), 'python');
});

// --- configuration & dynamic registration ---

test('configurationSection: dotted lookup, whole object, unknown → null', () => {
  const settings = { python: { pythonPath: '/v/bin/python', analysis: { typeCheckingMode: 'standard' } } };
  assert.deepEqual(conv.configurationSection(settings, 'python.analysis'), { typeCheckingMode: 'standard' });
  assert.equal(conv.configurationSection(settings, 'python.pythonPath'), '/v/bin/python');
  assert.equal(conv.configurationSection(settings, 'pyright'), null);
  assert.equal(conv.configurationSection(settings, 'python.analysis.missing'), null);
  assert.equal(conv.configurationSection(settings, undefined), settings);
});

test('effectiveCapabilities: dynamic registrations add or override features', () => {
  const registrations = new Map([
    ['1', { method: 'textDocument/formatting', registerOptions: { documentSelector: [] } }],
    ['2', { method: 'textDocument/rename' }],
    ['3', { method: 'workspace/didChangeWatchedFiles', registerOptions: {} }],
  ]);
  const caps = conv.effectiveCapabilities({ hoverProvider: true }, registrations);
  assert.equal(caps.hoverProvider, true);
  assert.deepEqual(caps.documentFormattingProvider, { documentSelector: [] });
  assert.equal(caps.renameProvider, true);
  assert.equal(Object.keys(caps).length, 3);
  registrations.delete('1');
  assert.equal(conv.effectiveCapabilities({}, registrations).documentFormattingProvider, undefined);
});
