const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonc, parseEnvFile, makeRunConfigLib } = require('../src/main/run-configs-lib');

const REPO = '/repo';
const lin = makeRunConfigLib(REPO, 'linux');
const win = makeRunConfigLib(REPO, 'win32');

// --- parseJsonc ---

test('parseJsonc: plain JSON', () => {
  assert.deepEqual(parseJsonc('{"a": 1, "b": [2, 3]}'), { a: 1, b: [2, 3] });
});

test('parseJsonc: strips // line comments and /* */ block comments', () => {
  const text = `{
    // a line comment
    "a": 1, /* inline block */ "b": 2
    /* multi
       line */
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test('parseJsonc: drops trailing commas in objects and arrays', () => {
  assert.deepEqual(parseJsonc('{ "a": [1, 2, ], }'), { a: [1, 2] });
});

test('parseJsonc: does not treat // or /* inside a string as a comment', () => {
  const r = parseJsonc('{ "url": "https://x.test/a", "glob": "/* not a comment */" }');
  assert.equal(r.url, 'https://x.test/a');
  assert.equal(r.glob, '/* not a comment */');
});

test('parseJsonc: respects escaped quotes inside strings', () => {
  const r = parseJsonc('{ "s": "a \\" // still in string", "n": 1 }');
  assert.equal(r.s, 'a " // still in string');
  assert.equal(r.n, 1);
});

// --- substVars ---

test('substVars: resolves workspace + path variables', () => {
  assert.equal(lin.substVars('${workspaceFolder}/src'), '/repo/src');
  assert.equal(lin.substVars('${workspaceRoot}'), '/repo');
  assert.equal(lin.substVars('${cwd}'), '/repo');
  assert.equal(lin.substVars('${workspaceFolderBasename}'), 'repo');
});

test('substVars: resolves ${env:NAME}', () => {
  process.env.__RC_TEST__ = 'hi';
  assert.equal(lin.substVars('x-${env:__RC_TEST__}'), 'x-hi');
  delete process.env.__RC_TEST__;
});

test('substVars: leaves unknown placeholders untouched (best effort)', () => {
  assert.equal(lin.substVars('${file}'), '${file}');
});

test('substVars: non-strings pass through', () => {
  assert.equal(lin.substVars(5), 5);
});

// --- buildLaunchCommand ---

test('buildLaunchCommand: node config', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'node', program: 'app.js', args: ['--port', '3000'] }),
    'node app.js --port 3000');
});

test('buildLaunchCommand: pwa-node type still maps to node', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'pwa-node', program: 'app.js' }), 'node app.js');
});

test('buildLaunchCommand: python and debugpy map to python', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'python', program: 'main.py' }), 'python main.py');
  assert.equal(lin.buildLaunchCommand({ type: 'debugpy', program: 'main.py' }), 'python main.py');
});

test('buildLaunchCommand: runtimeExecutable/runtimeArgs honoured', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'node', runtimeExecutable: 'tsx', runtimeArgs: ['--no-warnings'], program: 'a.ts' }),
    'tsx --no-warnings a.ts',
  );
});

test('buildLaunchCommand: TYPE_RUNTIME (go) needs a program', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'go', program: 'main.go' }), 'go run main.go');
});

test('buildLaunchCommand: resolves ${workspaceFolder} inside program/args', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'node', program: '${workspaceFolder}/server.js' }),
    'node /repo/server.js',
  );
});

test('buildLaunchCommand: quotes arguments containing spaces', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'node', program: 'a.js', args: ['hello world'] }),
    'node a.js "hello world"',
  );
});

test('buildLaunchCommand: godot uses --path and runs an explicit scene', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'godot', project: '${workspaceFolder}', scene: 'res://Main.tscn' }),
    'godot --path /repo res://Main.tscn',
  );
});

test('buildLaunchCommand: godot main/current scene runs the project (no scene arg)', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'godot', scene: 'main' }), 'godot --path /repo');
  assert.equal(lin.buildLaunchCommand({ type: 'godot' }), 'godot --path /repo');
});

test('buildLaunchCommand: bare program with no known type just runs it', () => {
  assert.equal(lin.buildLaunchCommand({ program: './run.sh' }), './run.sh');
});

test('buildLaunchCommand: returns null for an unrunnable config (browser/attach)', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'chrome', url: 'http://localhost' }), null);
  assert.equal(lin.buildLaunchCommand({ type: 'go' }), null); // TYPE_RUNTIME but no program
});

test('buildLaunchCommand: win32 rewrites the mvnw wrapper to mvnw.cmd', () => {
  // The Spring Boot launch.json case: type "node", runtimeExecutable points at the
  // extensionless Unix wrapper. On Windows it must run mvnw.cmd, not the script.
  const cfg = { type: 'node', runtimeExecutable: '${workspaceFolder}/mvnw', runtimeArgs: ['spring-boot:run', '-Pdev'] };
  assert.equal(win.buildLaunchCommand(cfg), '/repo/mvnw.cmd spring-boot:run -Pdev');
  // POSIX keeps the wrapper as-is.
  assert.equal(lin.buildLaunchCommand(cfg), '/repo/mvnw spring-boot:run -Pdev');
});

test('buildLaunchCommand: win32 rewrites gradlew to gradlew.bat', () => {
  assert.equal(win.buildLaunchCommand({ type: 'node', runtimeExecutable: 'gradlew', runtimeArgs: ['bootRun'] }),
    'gradlew.bat bootRun');
});

test('buildLaunchCommand: win32 leaves an already-suffixed or unrelated exe alone', () => {
  assert.equal(win.buildLaunchCommand({ type: 'node', runtimeExecutable: 'mvnw.cmd' }), 'mvnw.cmd');
  assert.equal(win.buildLaunchCommand({ type: 'node', runtimeExecutable: 'tsx', program: 'a.ts' }), 'tsx a.ts');
});

// --- parseEnvFile ---

test('parseEnvFile: parses KEY=VALUE lines, skips blanks and comments', () => {
  assert.deepEqual(parseEnvFile('A=1\n\n# a comment\nB=two\n'), { A: '1', B: 'two' });
});

test('parseEnvFile: strips matching surrounding quotes and honours export', () => {
  assert.deepEqual(parseEnvFile('export A="hi there"\nB=\'x\'\nC="unbalanced'),
    { A: 'hi there', B: 'x', C: '"unbalanced' });
});

test('parseEnvFile: keeps = inside the value, skips lines without =', () => {
  assert.deepEqual(parseEnvFile('URL=postgres://u:p@h/db?x=1\nnonsense'), { URL: 'postgres://u:p@h/db?x=1' });
});

// --- buildTaskCommand ---

test('buildTaskCommand: shell task keeps command verbatim, quotes args', () => {
  assert.equal(
    lin.buildTaskCommand({ type: 'shell', command: 'npm run build', args: ['--watch', 'a b'] }),
    'npm run build --watch "a b"',
  );
});

test('buildTaskCommand: process task quotes the command too', () => {
  assert.equal(
    lin.buildTaskCommand({ type: 'process', command: 'my prog', args: ['x'] }),
    '"my prog" x',
  );
});

test('buildTaskCommand: command/args may be {value} objects', () => {
  assert.equal(
    lin.buildTaskCommand({ command: { value: 'echo' }, args: [{ value: 'hi' }] }),
    'echo hi',
  );
});

test('buildTaskCommand: returns null with no command', () => {
  assert.equal(lin.buildTaskCommand({ args: ['x'] }), null);
});

// --- chainCommands (platform-specific) ---

test('chainCommands: posix joins with &&', () => {
  assert.equal(lin.chainCommands(['a', 'b', 'c']), 'a && b && c');
});

test('chainCommands: windows gates each step on $?', () => {
  assert.equal(win.chainCommands(['a', 'b', 'c']), 'a; if ($?) { b; if ($?) { c } }');
});

test('chainCommands: single/empty', () => {
  assert.equal(lin.chainCommands(['only']), 'only');
  assert.equal(lin.chainCommands([]), '');
});

// --- resolveTask ---

test('resolveTask: a plain task yields one spec at the repo root', () => {
  const t = { label: 'build', type: 'shell', command: 'make' };
  assert.deepEqual(lin.resolveTask([t], t), [
    { command: 'make', cwd: '/repo', env: {}, name: 'build' },
  ]);
});

test('resolveTask: options.cwd and options.env are resolved', () => {
  const t = { label: 'x', command: 'run', options: { cwd: '${workspaceFolder}/sub', env: { K: '${workspaceFolderBasename}' } } };
  assert.deepEqual(lin.resolveTask([t], t), [
    { command: 'run', cwd: '/repo/sub', env: { K: 'repo' }, name: 'x' },
  ]);
});

test('resolveTask: parallel compound yields one spec per dependency (default order)', () => {
  const a = { label: 'a', command: 'cmdA' };
  const b = { label: 'b', command: 'cmdB' };
  const comp = { label: 'all', dependsOn: ['a', 'b'] };
  const specs = lin.resolveTask([a, b, comp], comp);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.command), ['cmdA', 'cmdB']);
});

test('resolveTask: sequence compound collapses to one chained terminal', () => {
  const a = { label: 'a', command: 'cmdA' };
  const b = { label: 'b', command: 'cmdB' };
  const comp = { label: 'all', dependsOn: ['a', 'b'], dependsOrder: 'sequence' };
  const specs = lin.resolveTask([a, b, comp], comp);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].command, 'cmdA && cmdB');
  assert.equal(specs[0].name, 'all');
});

test('resolveTask: sequence step with its own cwd gets a cd prefix', () => {
  const a = { label: 'a', command: 'cmdA', options: { cwd: '${workspaceFolder}/sub' } };
  const b = { label: 'b', command: 'cmdB' };
  const comp = { label: 'all', dependsOn: ['a', 'b'], dependsOrder: 'sequence' };
  const specs = lin.resolveTask([a, b, comp], comp);
  assert.equal(specs[0].command, "cd '/repo/sub' && cmdA && cmdB");
});

test('resolveTask: a compound may carry its own command, run after deps', () => {
  const a = { label: 'a', command: 'cmdA' };
  const comp = { label: 'all', dependsOn: ['a'], dependsOrder: 'sequence', command: 'cmdOwn' };
  const specs = lin.resolveTask([a, comp], comp);
  assert.equal(specs[0].command, 'cmdA && cmdOwn');
});

test('resolveTask: a dependency cycle terminates (no infinite recursion)', () => {
  const a = { label: 'a', command: 'cmdA', dependsOn: 'b' };
  const b = { label: 'b', command: 'cmdB', dependsOn: 'a' };
  const specs = lin.resolveTask([a, b], a);
  // Must return *something* finite rather than hang/throw.
  assert.ok(Array.isArray(specs));
});

test('resolveTask: a single string dependsOn is accepted', () => {
  const a = { label: 'a', command: 'cmdA' };
  const comp = { label: 'all', dependsOn: 'a' };
  assert.deepEqual(lin.resolveTask([a, comp], comp).map((s) => s.command), ['cmdA']);
});
