const { test } = require('node:test');
const assert = require('node:assert/strict');
const { langForFile, langById, buildRunCommand } = require('../src/main/runners-lib');

// --- langForFile ---

test('langForFile: maps known extensions to their language', () => {
  assert.equal(langForFile('a/b/script.py').id, 'python');
  assert.equal(langForFile('index.mjs').id, 'node');
  assert.equal(langForFile('App.ts').id, 'typescript');
  assert.equal(langForFile('main.go').id, 'go');
  assert.equal(langForFile('build.ps1').id, 'powershell');
});

test('langForFile: case-insensitive on the extension', () => {
  assert.equal(langForFile('SCRIPT.PY').id, 'python');
});

test('langForFile: unknown / extensionless files are not runnable', () => {
  assert.equal(langForFile('notes.txt'), null);
  assert.equal(langForFile('Makefile'), null);
  assert.equal(langForFile(''), null);
});

// --- buildRunCommand ---

test('buildRunCommand: simple interpreter + file', () => {
  const py = langById('python');
  assert.equal(buildRunCommand(py, 'python', 'app.py'), 'python app.py');
});

test('buildRunCommand: go uses `run`, powershell uses -File', () => {
  assert.equal(buildRunCommand(langById('go'), 'go', 'main.go'), 'go run main.go');
  assert.equal(buildRunCommand(langById('powershell'), 'pwsh', 'b.ps1'), 'pwsh -File b.ps1');
});

test('buildRunCommand: deno gets `run`, other ts runners do not', () => {
  const ts = langById('typescript');
  assert.equal(buildRunCommand(ts, 'deno', 'a.ts'), 'deno run a.ts');
  assert.equal(buildRunCommand(ts, 'tsx', 'a.ts'), 'tsx a.ts');
});

test('buildRunCommand: quotes paths/binaries with spaces', () => {
  const py = langById('python');
  assert.equal(
    buildRunCommand(py, 'C:\\Program Files\\Python\\python.exe', 'my script.py'),
    '"C:\\Program Files\\Python\\python.exe" "my script.py"',
  );
});

test('buildRunCommand: appends extra args verbatim, trimmed', () => {
  const py = langById('python');
  assert.equal(buildRunCommand(py, 'python', 'app.py', '  --verbose -n 3 '), 'python app.py --verbose -n 3');
  assert.equal(buildRunCommand(py, 'python', 'app.py', ''), 'python app.py');
});
