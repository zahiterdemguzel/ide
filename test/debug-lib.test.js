const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  encodeDapMessage, createDapReader, adapterFor, findPlaceholders, adapterArguments,
  fileDebugTarget, attachSocketTarget, pythonCommand, newestBundledDebugpy, shellCommandLine, terminalEnv,
  sourceBreakpoints, defaultExceptionFilters, repoRelative,
} = require('../src/main/debug-lib');
const { makeRunConfigLib } = require('../src/main/run-configs-lib');

const REPO = '/repo';
const lib = makeRunConfigLib(REPO, 'linux');

// --- framing ---

test('encodeDapMessage: Content-Length counts UTF-8 bytes, not characters', () => {
  const frame = encodeDapMessage({ text: 'ı' }); // 2 bytes in UTF-8
  const body = '{"text":"ı"}';
  assert.equal(frame, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.notEqual(Buffer.byteLength(body), body.length);
});

test('createDapReader: reassembles messages split across chunks and batched together', () => {
  const got = [];
  const reader = createDapReader((m) => got.push(m));
  const a = encodeDapMessage({ seq: 1, text: 'çğü' });
  const b = encodeDapMessage({ seq: 2 });
  const bytes = Buffer.from(a + b, 'utf8');
  // Feed one byte at a time — splits land inside headers and multi-byte characters.
  for (let i = 0; i < bytes.length; i++) reader.push(bytes.slice(i, i + 1));
  assert.deepEqual(got, [{ seq: 1, text: 'çğü' }, { seq: 2 }]);
  reader.push(Buffer.from(b + a, 'utf8'));
  assert.deepEqual(got.map((m) => m.seq), [1, 2, 2, 1]);
});

// --- which configs debug ---

test('adapterFor: debugpy and python configs use debugpy; others have no adapter yet', () => {
  assert.equal(adapterFor({ type: 'debugpy' }), 'debugpy');
  assert.equal(adapterFor({ type: 'Python' }), 'debugpy');
  assert.equal(adapterFor({ type: 'node' }), null);
  assert.equal(adapterFor(undefined), null);
});

// --- launch.json -> adapter arguments ---

test('adapterArguments: resolves variables deeply and drops client-only keys', () => {
  const cfg = {
    name: 'Blender', type: 'debugpy', request: 'attach', preLaunchTask: 'start', presentation: { hidden: false },
    connect: { host: '127.0.0.1', port: 5679 },
    pathMappings: [{ localRoot: '${workspaceFolder}/addons/x', remoteRoot: '${workspaceFolder}/.dev/x' }],
    justMyCode: false,
  };
  assert.deepEqual(adapterArguments(cfg, lib), {
    name: 'Blender', type: 'debugpy', request: 'attach',
    connect: { host: '127.0.0.1', port: 5679 },
    pathMappings: [{ localRoot: '/repo/addons/x', remoteRoot: '/repo/.dev/x' }],
    justMyCode: false,
  });
});

test('adapterArguments: a launch gets the terminal console, repo cwd, and envFile under env', () => {
  const args = adapterArguments(
    { name: 'App', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/main.py', env: { A: '1', N: 2 }, envFile: '.env' },
    lib, { A: 'from-file', B: 'b' },
  );
  assert.equal(args.program, '/repo/main.py');
  assert.equal(args.console, 'integratedTerminal');
  assert.equal(args.cwd, '/repo');
  assert.deepEqual(args.env, { A: '1', B: 'b', N: '2' });
  assert.equal('envFile' in args, false);
  // An explicit console choice is kept.
  assert.equal(adapterArguments({ type: 'debugpy', request: 'launch', console: 'internalConsole' }, lib).console, 'internalConsole');
});

test('adapterArguments: the per-OS block is merged before translation', () => {
  const mac = makeRunConfigLib(REPO, 'darwin');
  const args = adapterArguments({ type: 'debugpy', request: 'launch', program: 'a.py', osx: { program: 'b.py' } }, mac);
  assert.equal(args.program, 'b.py');
  assert.equal('osx' in args, false);
});

test('findPlaceholders: finds unresolved inputs anywhere in nested args', () => {
  const v = { a: '${input:port}', b: [{ c: 'x ${input:host} ${command:pickProcess}' }] };
  assert.deepEqual(findPlaceholders(v, 'input').sort(), ['host', 'port']);
  assert.deepEqual(findPlaceholders(v, 'command'), ['pickProcess']);
});

// --- connecting ---

test('attachSocketTarget: connect/host+port attach goes over TCP; other shapes spawn an adapter', () => {
  assert.deepEqual(attachSocketTarget({ request: 'attach', connect: { port: 5678 } }), { host: '127.0.0.1', port: 5678 });
  assert.deepEqual(attachSocketTarget({ request: 'attach', host: 'box', port: '9000' }), { host: 'box', port: 9000 });
  assert.equal(attachSocketTarget({ request: 'attach', processId: 123, connect: { port: 1 } }), null);
  assert.equal(attachSocketTarget({ request: 'attach', listen: { port: 5678 } }), null);
  assert.equal(attachSocketTarget({ request: 'launch', port: 5678 }), null);
  assert.equal(attachSocketTarget({ request: 'attach' }), null);
});

test('pythonCommand: config python, then the project .venv, then python on PATH', () => {
  const none = () => false;
  assert.deepEqual(pythonCommand({ python: '/usr/bin/python3.12' }, REPO, 'linux', none), ['/usr/bin/python3.12']);
  assert.deepEqual(pythonCommand({ python: ['uv', 'run', 'python'] }, REPO, 'linux', none), ['uv', 'run', 'python']);
  assert.deepEqual(pythonCommand({ pythonPath: 'py' }, REPO, 'linux', none), ['py']);
  const venv = path.join(REPO, '.venv', 'bin', 'python');
  assert.deepEqual(pythonCommand({}, REPO, 'linux', (p) => p === venv), [venv]);
  assert.deepEqual(pythonCommand({}, REPO, 'linux', none), ['python3']);
  assert.deepEqual(pythonCommand({}, REPO, 'win32', none), ['python']);
});

test('newestBundledDebugpy: picks the highest debugpy extension version', () => {
  const dir = '/ext';
  const picked = newestBundledDebugpy(dir, [
    'ms-python.python-2026.4.0', 'ms-python.debugpy-2025.10.0-darwin-arm64',
    'ms-python.debugpy-2026.6.0-darwin-arm64', 'ms-python.debugpy-2026.10.1',
  ]);
  assert.equal(picked, path.join(dir, 'ms-python.debugpy-2026.10.1', 'bundled', 'libs'));
  assert.equal(newestBundledDebugpy(dir, ['other']), null);
});

// --- runInTerminal ---

test('shellCommandLine: POSIX quoting leaves plain words bare and single-quotes the rest', () => {
  assert.equal(
    shellCommandLine(['/v/bin/python', '/x/launcher', '--', '/my dir/a.py', "it's"], 'darwin'),
    "/v/bin/python /x/launcher -- '/my dir/a.py' 'it'\\''s'",
  );
});

test('shellCommandLine: PowerShell needs the call operator before a quoted program', () => {
  assert.equal(shellCommandLine(['C:\\Py 3\\python.exe', 'a b'], 'win32'), "& 'C:\\Py 3\\python.exe' 'a b'");
  assert.equal(shellCommandLine(['python', "it's"], 'win32'), "python 'it''s'");
});

test('terminalEnv: drops the null "unset" entries and stringifies values', () => {
  assert.deepEqual(terminalEnv({ A: 'x', B: null, C: 3 }), { A: 'x', C: '3' });
});

// --- breakpoints & frames ---

test('sourceBreakpoints: keeps only the DAP fields that are set', () => {
  assert.deepEqual(
    sourceBreakpoints([{ line: 3, enabled: true }, { line: 7, condition: 'x > 1', logMessage: '' }, { line: 9, logMessage: 'x={x}', hitCondition: '2' }]),
    [{ line: 3 }, { line: 7, condition: 'x > 1' }, { line: 9, hitCondition: '2', logMessage: 'x={x}' }],
  );
});

test('defaultExceptionFilters: only the filters the adapter marks default', () => {
  const caps = { exceptionBreakpointFilters: [{ filter: 'raised', default: false }, { filter: 'uncaught', default: true }] };
  assert.deepEqual(defaultExceptionFilters(caps), ['uncaught']);
  assert.deepEqual(defaultExceptionFilters(null), []);
});

test('repoRelative: in-repo paths become forward-slash relative, others null', () => {
  assert.equal(repoRelative('/repo', '/repo/src/a.py'), 'src/a.py');
  assert.equal(repoRelative('/repo', '/usr/lib/python3/os.py'), null);
  assert.equal(repoRelative('/repo', '/repo'), null);
  assert.equal(repoRelative(null, '/repo/a.py'), null);
});

test('fileDebugTarget: launches the file from the repo root, on the registered interpreter if any', () => {
  const t = fileDebugTarget('/repo/tools/x.py', '/repo', '/opt/py/bin/python');
  assert.equal(t.name, 'Debug x.py');
  assert.equal(t.adapter, 'debugpy');
  assert.deepEqual(t.args, {
    name: 'Debug x.py', type: 'debugpy', request: 'launch', program: '/repo/tools/x.py',
    cwd: '/repo', console: 'integratedTerminal', justMyCode: true, python: ['/opt/py/bin/python'],
  });
  assert.equal('python' in fileDebugTarget('/repo/a.py', '/repo').args, false);
});
