import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  encodeMessage, createMessageReader, SERVERS, serverForLanguage, serverKey, resolveLaunch,
  extraSearchDirs, searchDirs, findExecutable, parseLoginShellPath, loginShellPathCommand,
  unpackedPath, serverEnv, spawnInvocation, findVenvPython, serverSettings,
} = require('../src/main/lsp-lib.js');

// --- framing ---

test('encodeMessage: Content-Length counts UTF-8 bytes and accepts strings or objects', () => {
  const body = '{"text":"ğüş"}';
  const frame = encodeMessage(body).toString('utf8');
  assert.equal(frame, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.equal(encodeMessage({ text: 'ğüş' }).toString('utf8'), frame);
});

test('createMessageReader: reassembles messages split anywhere, including inside multi-byte characters', () => {
  const got = [];
  const reader = createMessageReader((body) => got.push(JSON.parse(body)));
  const bytes = Buffer.concat([encodeMessage({ id: 1, text: 'çğü 😀' }), encodeMessage({ id: 2 })]);
  for (let i = 0; i < bytes.length; i++) reader.push(bytes.subarray(i, i + 1));
  assert.deepEqual(got, [{ id: 1, text: 'çğü 😀' }, { id: 2 }]);
});

test('createMessageReader: several messages in one chunk, plus a partial tail completed later', () => {
  const got = [];
  const reader = createMessageReader((body) => got.push(JSON.parse(body).id));
  const third = encodeMessage({ id: 3, pad: 'x'.repeat(1000) });
  reader.push(Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 }), third.subarray(0, 30)]));
  assert.deepEqual(got, [1, 2]);
  reader.push(third.subarray(30));
  assert.deepEqual(got, [1, 2, 3]);
});

test('createMessageReader: tolerates extra headers and skips a header block without Content-Length', () => {
  const got = [];
  const reader = createMessageReader((body) => got.push(JSON.parse(body).id));
  const body = '{"id":7}';
  reader.push(`junk header\r\n\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  assert.deepEqual(got, [7]);
});

// --- registry ---

test('registry: every language maps to exactly one server and ids are unique', () => {
  const ids = SERVERS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const languages = SERVERS.flatMap((s) => s.languages);
  assert.equal(new Set(languages).size, languages.length);
  assert.equal(serverForLanguage('python').id, 'pyright');
  assert.equal(serverForLanguage('typescript').id, serverForLanguage('javascript').id);
  assert.equal(serverForLanguage('cpp').id, 'clangd');
  assert.equal(serverForLanguage('plaintext'), null);
});

test('serverKey: one server per (server, root)', () => {
  assert.notEqual(serverKey('pyright', '/a'), serverKey('pyright', '/b'));
  assert.equal(serverKey('pyright', '/a'), serverKey('pyright', '/a'));
});

// --- launch resolution ---

function ctx(overrides = {}) {
  return {
    which: () => null,
    bundled: (rel) => `/app/node_modules/${rel}`,
    exists: () => false,
    execPath: '/app/Electron',
    platform: 'darwin',
    arch: 'arm64',
    root: '/proj',
    cacheDir: '/cache',
    ...overrides,
  };
}

test('resolveLaunch: bundled pyright runs under the app binary as Node', () => {
  const plan = resolveLaunch('python', ctx());
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'bundled');
  assert.equal(plan.command, '/app/Electron');
  assert.deepEqual(plan.args, ['/app/node_modules/pyright/langserver.index.js', '--stdio']);
  assert.equal(plan.runAsNode, true);
});

test('resolveLaunch: TypeScript prefers the native TS 7 binary for this platform', () => {
  const plan = resolveLaunch('javascript', ctx({ platform: 'win32', arch: 'x64' }));
  assert.equal(plan.command, '/app/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe');
  assert.deepEqual(plan.args, ['--lsp', '--stdio']);
  assert.equal(plan.runAsNode, false);
  assert.deepEqual(plan.languages, ['typescript', 'javascript']);
});

test('resolveLaunch: falls back to typescript-language-server with the project tsserver', () => {
  const bundled = (rel) => (rel.startsWith('@typescript/') ? null : `/app/node_modules/${rel}`);
  const tsserver = '/proj/node_modules/typescript/lib/tsserver.js';
  const plan = resolveLaunch('typescript', ctx({ bundled, exists: (p) => p === tsserver }));
  assert.equal(plan.name, 'typescript-language-server');
  assert.equal(plan.runAsNode, true);
  assert.deepEqual(plan.initializationOptions.tsserver, { path: tsserver });
});

test('resolveLaunch: no native binary and no tsserver anywhere → unavailable', () => {
  const bundled = (rel) => (rel.startsWith('@typescript/') || rel.startsWith('typescript/') ? null : `/app/node_modules/${rel}`);
  const plan = resolveLaunch('typescript', ctx({ bundled }));
  assert.equal(plan.ok, false);
});

test('resolveLaunch: PATH servers use which() and report an install hint when missing', () => {
  const found = resolveLaunch('go', ctx({ which: (cmd) => (cmd === 'gopls' ? '/Users/me/go/bin/gopls' : null) }));
  assert.equal(found.ok, true);
  assert.equal(found.source, 'path');
  assert.equal(found.command, '/Users/me/go/bin/gopls');
  const missing = resolveLaunch('go', ctx());
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /gopls/);
  assert.match(missing.reason, /go install/);
});

test('resolveLaunch: later candidates and platform-only candidates (xcrun on macOS)', () => {
  const which = (cmd) => (cmd === 'xcrun' ? '/usr/bin/xcrun' : null);
  const mac = resolveLaunch('swift', ctx({ which }));
  assert.equal(mac.command, '/usr/bin/xcrun');
  assert.deepEqual(mac.args, ['sourcekit-lsp']);
  assert.equal(resolveLaunch('swift', ctx({ which, platform: 'linux' })).ok, false);
  const ruby = resolveLaunch('ruby', ctx({ which: (cmd) => (cmd === 'solargraph' ? '/bin/solargraph' : null) }));
  assert.deepEqual(ruby.args, ['stdio']);
  assert.equal(ruby.name, 'Solargraph');
});

test('resolveLaunch: jdtls gets a per-project data dir under the cache dir', () => {
  const plan = resolveLaunch('java', ctx({ which: () => '/bin/jdtls' }));
  assert.equal(plan.args[0], '-data');
  assert.ok(plan.args[1].startsWith('/cache/jdtls/'));
  const other = resolveLaunch('java', ctx({ which: () => '/bin/jdtls', root: '/other' }));
  assert.notEqual(plan.args[1], other.args[1]);
});

test('resolveLaunch: GDScript is a TCP plan carrying the "open Godot" message', () => {
  const plan = resolveLaunch('gdscript', ctx());
  assert.equal(plan.transport, 'tcp');
  assert.equal(plan.port, 6005);
  assert.match(plan.unreachable, /Godot editor/);
});

test('resolveLaunch: a language with no server is flagged unknown', () => {
  const plan = resolveLaunch('markdown', ctx());
  assert.equal(plan.ok, false);
  assert.equal(plan.unknown, true);
});

// --- finding executables ---

test('extraSearchDirs: covers the common install dirs a GUI app misses', () => {
  const dirs = extraSearchDirs({ home: '/Users/me', platform: 'darwin', env: { GOPATH: '/gp' } });
  for (const d of ['/gp/bin', '/Users/me/go/bin', '/Users/me/.cargo/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.local/bin']) {
    assert.ok(dirs.includes(d), d);
  }
  const win = extraSearchDirs({ home: 'C:\\Users\\me', platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } });
  assert.ok(win.includes('C:\\Users\\me\\AppData\\Roaming\\npm'));
});

test('searchDirs: inherited PATH first, then login-shell PATH, then extras, de-duplicated', () => {
  const dirs = searchDirs({ envPath: '/usr/bin:/bin', loginShellPath: '/opt/homebrew/bin:/usr/bin', extra: ['/bin', '/x'], platform: 'darwin' });
  assert.deepEqual(dirs, ['/usr/bin', '/bin', '/opt/homebrew/bin', '/x']);
});

test('findExecutable: searches dirs in order, tries PATHEXT on Windows, accepts absolute names', () => {
  const files = new Set(['/b/gopls', '/c/gopls', 'C:\\npm\\intelephense.cmd']);
  const isFile = (p) => files.has(p);
  assert.equal(findExecutable('gopls', ['/a', '/b', '/c'], { platform: 'darwin', isFile }), '/b/gopls');
  assert.equal(findExecutable('nope', ['/a'], { platform: 'darwin', isFile }), null);
  assert.equal(findExecutable('/c/gopls', [], { platform: 'darwin', isFile }), '/c/gopls');
  assert.equal(findExecutable('intelephense', ['C:\\npm'], { platform: 'win32', isFile, pathext: '.EXE;.CMD' }), 'C:\\npm\\intelephense.cmd');
});

test('parseLoginShellPath: extracts the PATH between markers despite rc-file noise', () => {
  const cmd = loginShellPathCommand();
  assert.match(cmd, /\$PATH/);
  assert.equal(parseLoginShellPath('Welcome!\n__LSP_PATH__/opt/homebrew/bin:/usr/bin__LSP_PATH__\nbye'), '/opt/homebrew/bin:/usr/bin');
  assert.equal(parseLoginShellPath('no markers'), null);
  assert.equal(parseLoginShellPath(undefined), null);
});

// --- spawning ---

test('unpackedPath: redirects into app.asar.unpacked only for packaged paths', () => {
  assert.equal(unpackedPath('/A.app/Contents/Resources/app.asar/node_modules/pyright/x.js'),
    '/A.app/Contents/Resources/app.asar.unpacked/node_modules/pyright/x.js');
  assert.equal(unpackedPath('C:\\App\\resources\\app.asar\\node_modules\\x'), 'C:\\App\\resources\\app.asar.unpacked\\node_modules\\x');
  assert.equal(unpackedPath('/repo/node_modules/pyright/x.js'), '/repo/node_modules/pyright/x.js');
});

test('serverEnv: scrubs debugger pollution, sets PATH and ELECTRON_RUN_AS_NODE only for bundled scripts', () => {
  const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '9', HOME: '/h' };
  const plain = serverEnv(base, { runAsNode: false, path: '/x:/y', platform: 'darwin' });
  assert.equal(plain.PATH, '/x:/y');
  assert.equal(plain.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(plain.VSCODE_PID, undefined);
  assert.equal(plain.HOME, '/h');
  assert.equal(serverEnv(base, { runAsNode: true, platform: 'darwin' }).ELECTRON_RUN_AS_NODE, '1');
  const win = serverEnv({ Path: 'C:\\old' }, { runAsNode: false, path: 'C:\\new', platform: 'win32' });
  assert.equal(win.Path, 'C:\\new');
  assert.equal(win.PATH, undefined);
});

test('spawnInvocation: .cmd/.bat go through the shell on Windows, quoted', () => {
  assert.deepEqual(spawnInvocation('/bin/gopls', ['serve'], 'darwin'), { command: '/bin/gopls', args: ['serve'], shell: false });
  const win = spawnInvocation('C:\\Program Files\\npm\\yaml-language-server.cmd', ['--stdio'], 'win32');
  assert.equal(win.shell, true);
  assert.equal(win.command, '"C:\\Program Files\\npm\\yaml-language-server.cmd"');
  assert.deepEqual(win.args, ['--stdio']);
  assert.equal(spawnInvocation('C:\\x\\gopls.exe', [], 'win32').shell, false);
});

// --- workspace settings ---

test('findVenvPython: .venv, then venv, then env, per platform', () => {
  assert.equal(findVenvPython('/p', 'darwin', (p) => p === '/p/venv/bin/python'), '/p/venv/bin/python');
  assert.equal(findVenvPython('/p', 'darwin', (p) => p === '/p/.venv/bin/python' || p === '/p/venv/bin/python'), '/p/.venv/bin/python');
  assert.equal(findVenvPython('C:\\p', 'win32', (p) => p === 'C:\\p\\.venv\\Scripts\\python.exe'), 'C:\\p\\.venv\\Scripts\\python.exe');
  assert.equal(findVenvPython('/p', 'darwin', () => false), null);
  assert.equal(findVenvPython(null, 'darwin', () => true), null);
});

test('serverSettings: pyright analysis defaults plus the venv interpreter when present', () => {
  const s = serverSettings('pyright', { pythonPath: '/p/.venv/bin/python' });
  assert.equal(s.python.pythonPath, '/p/.venv/bin/python');
  assert.equal(s.python.analysis.diagnosticMode, 'openFilesOnly');
  assert.equal(s.python.analysis.typeCheckingMode, 'standard');
  assert.equal('pythonPath' in serverSettings('pyright', {}).python, false);
  assert.deepEqual(serverSettings('gopls'), {});
  assert.ok(serverSettings('typescript').typescript.inlayHints);
});
