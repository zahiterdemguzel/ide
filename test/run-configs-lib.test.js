const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseJsonc, parseEnvFile, compoundMembers, listRunConfigs, autoDetectedNpmTask, findInputIds, findCommandIds, defaultBuildTaskName, makeRunConfigLib } = require('../src/main/run-configs-lib');

const REPO = '/repo';
const lin = makeRunConfigLib(REPO, 'linux');
const win = makeRunConfigLib(REPO, 'win32');
const mac = makeRunConfigLib(REPO, 'darwin');

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

// --- compoundMembers ---

test('compoundMembers: plain string members', () => {
  assert.deepEqual(compoundMembers({ configurations: ['Server', 'Client'] }), ['Server', 'Client']);
});

test('compoundMembers: { name } object members and a mix', () => {
  assert.deepEqual(compoundMembers({ configurations: [{ name: 'Server' }, 'Client'] }), ['Server', 'Client']);
});

test('compoundMembers: missing/empty configurations and falsy entries', () => {
  assert.deepEqual(compoundMembers({}), []);
  assert.deepEqual(compoundMembers(null), []);
  assert.deepEqual(compoundMembers({ configurations: [null, '', 'Real', { foo: 1 }] }), ['Real']);
});

// --- listRunConfigs ---

test('listRunConfigs: launch configs, then compounds; tasks by label', () => {
  const r = listRunConfigs(
    { configurations: [{ name: 'Server' }, { name: 'Client' }], compounds: [{ name: 'Both', configurations: ['Server', 'Client'] }] },
    { tasks: [{ label: 'Build' }, { taskName: 'Legacy' }] },
  );
  assert.deepEqual(r.launch, [
    { name: 'Server' }, { name: 'Client' },
    { name: 'Both', compound: true, members: ['Server', 'Client'] },
  ]);
  assert.deepEqual(r.tasks, [{ name: 'Build' }, { name: 'Legacy' }]);
});

test('listRunConfigs: drops hidden entries and sorts by presentation.order', () => {
  const r = listRunConfigs(
    {
      configurations: [
        { name: 'Last', presentation: { order: 2 } },
        { name: 'Hidden', presentation: { hidden: true } },
        { name: 'First', presentation: { order: 1 } },
      ],
    },
    { tasks: [{ label: 'Shown' }, { label: 'Gone', hide: true }] },
  );
  assert.deepEqual(r.launch.map((c) => c.name), ['First', 'Last']);
  assert.deepEqual(r.tasks, [{ name: 'Shown' }]);
});

test('listRunConfigs: de-dupes names within a list, first wins', () => {
  const r = listRunConfigs(
    { configurations: [{ name: 'Dev' }, { name: 'Dev' }], compounds: [{ name: 'Dev', configurations: ['Dev'] }] },
    { tasks: [{ label: 'npm install' }, { label: 'npm install' }] },
  );
  assert.deepEqual(r.launch, [{ name: 'Dev' }]);
  assert.deepEqual(r.tasks, [{ name: 'npm install' }]);
});

test('listRunConfigs: a task and a launch config may share a name', () => {
  const r = listRunConfigs({ configurations: [{ name: 'Build' }] }, { tasks: [{ label: 'Build' }] });
  assert.deepEqual(r.launch, [{ name: 'Build' }]);
  assert.deepEqual(r.tasks, [{ name: 'Build' }]);
});

test('listRunConfigs: missing files and nameless entries', () => {
  assert.deepEqual(listRunConfigs(null, null), { launch: [], tasks: [] });
  assert.deepEqual(listRunConfigs({ configurations: [{}, null] }, { tasks: [{}, null] }), { launch: [], tasks: [] });
});

// VS Code lists a task per package.json script even with no tasks.json at all.
test('listRunConfigs: package.json scripts appear as auto-detected npm tasks', () => {
  assert.deepEqual(listRunConfigs(null, null, ['build', 'test']).tasks, [
    { name: 'npm: build' }, { name: 'npm: test' },
  ]);
  // A tasks.json entry with the same label is the customized version and wins.
  const r = listRunConfigs(null, { tasks: [{ label: 'npm: build', command: 'yarn build' }] }, ['build', 'dev']);
  assert.deepEqual(r.tasks, [{ name: 'npm: build' }, { name: 'npm: dev' }]);
});

test('autoDetectedNpmTask: only the npm: prefix synthesizes a task', () => {
  assert.deepEqual(autoDetectedNpmTask('npm: build'), { type: 'npm', script: 'build', label: 'npm: build' });
  assert.equal(autoDetectedNpmTask('build'), null);
  assert.equal(lin.buildTaskCommand(autoDetectedNpmTask('npm: test')), 'npm run test');
});

test('findCommandIds: ${command:...} left unresolved is reported', () => {
  const specs = [{ command: 'gdb ${command:cmake.launchTargetPath}', cwd: '/repo', env: { P: '${command:pickProcess}' } }];
  assert.deepEqual(findCommandIds(specs).sort(), ['cmake.launchTargetPath', 'pickProcess']);
  assert.deepEqual(findCommandIds([{ command: 'ls', cwd: '/repo', env: {} }]), []);
});

test('substVars: a collected ${command:...} answer is substituted', () => {
  const withAnswer = makeRunConfigLib(REPO, 'linux', { inputs: { 'command:cmake.launchTargetPath': '/repo/build/app' } });
  assert.equal(withAnswer.substVars('${command:cmake.launchTargetPath}'), '/repo/build/app');
  // No answer yet: left alone, which is how findCommandIds finds it.
  assert.equal(lin.substVars('${command:pickProcess}'), '${command:pickProcess}');
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

test('substVars: ctx-backed variables (userHome, config, defaultBuildTask, input)', () => {
  const l = makeRunConfigLib(REPO, 'linux', {
    home: '/home/u',
    settings: { 'my.port': 8080 },
    defaultBuildTask: 'build',
    inputs: { env: 'staging' },
  });
  assert.equal(l.substVars('${userHome}/x'), '/home/u/x');
  assert.equal(l.substVars('--port=${config:my.port}'), '--port=8080');
  assert.equal(l.substVars('${defaultBuildTask}'), 'build');
  assert.equal(l.substVars('deploy-${input:env}'), 'deploy-staging');
  // An unanswered input and a missing config key behave like VS Code best-effort:
  assert.equal(l.substVars('${input:other}'), '${input:other}');
  assert.equal(l.substVars('${config:absent}'), '');
});

test('substVars: without ctx, userHome/defaultBuildTask stay untouched', () => {
  assert.equal(lin.substVars('${userHome}'), '${userHome}');
  assert.equal(lin.substVars('${defaultBuildTask}'), '${defaultBuildTask}');
});

test('substVars: ${file}-family variables from ctx.activeFile', () => {
  const af = path.join(REPO, 'src', 'app.test.js');
  const l = makeRunConfigLib(REPO, 'linux', { activeFile: af });
  assert.equal(l.substVars('${file}'), af);
  assert.equal(l.substVars('${fileBasename}'), 'app.test.js');
  assert.equal(l.substVars('${fileBasenameNoExtension}'), 'app.test');
  assert.equal(l.substVars('${fileExtname}'), '.js');
  assert.equal(l.substVars('${fileDirname}'), path.join(REPO, 'src'));
  assert.equal(l.substVars('${fileDirnameBasename}'), 'src');
  assert.equal(l.substVars('${relativeFile}'), path.join('src', 'app.test.js'));
  assert.equal(l.substVars('${relativeFileDirname}'), 'src');
  assert.equal(l.substVars('${fileWorkspaceFolder}'), REPO);
  // No active file: left untouched.
  assert.equal(lin.substVars('${fileBasename}'), '${fileBasename}');
});

// --- findInputIds / defaultBuildTaskName ---

test('findInputIds: collects unresolved input ids across command/cwd/env', () => {
  assert.deepEqual(findInputIds([
    { command: 'run ${input:a} ${input:b}', cwd: '/x/${input:c}', env: { K: '${input:a}' } },
  ]).sort(), ['a', 'b', 'c']);
  assert.deepEqual(findInputIds([{ command: 'plain' }]), []);
});

test('defaultBuildTaskName: isDefault wins, plain "build" group is a fallback', () => {
  const t1 = { label: 'compile', group: 'build' };
  const t2 = { label: 'bundle', group: { kind: 'build', isDefault: true } };
  assert.equal(defaultBuildTaskName([t1, t2]), 'bundle');
  assert.equal(defaultBuildTaskName([t1]), 'compile');
  assert.equal(defaultBuildTaskName([{ label: 'x', group: 'test' }]), undefined);
});

// --- buildLaunchCommand ---

test('buildLaunchCommand: node config', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'node', program: 'app.js', args: ['--port', '3000'] }),
    'node app.js --port 3000');
});

test('buildLaunchCommand: pwa-node type still maps to node', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'pwa-node', program: 'app.js' }), 'node app.js');
});

test('substVars: editor caret/selection, execPath, and the multi-root folder form', () => {
  const ed = makeRunConfigLib(REPO, 'linux', {
    execPath: '/usr/bin/code', lineNumber: 42, columnNumber: 7, selectedText: 'foo',
  });
  assert.equal(ed.substVars('${execPath} ${lineNumber}:${columnNumber} ${selectedText}'), '/usr/bin/code 42:7 foo');
  // Only one folder is ever open, so the named form resolves to it rather than
  // leaving a ${...} on the command line.
  assert.equal(lin.substVars('${workspaceFolder:api}/x'), '/repo/x');
  // With no editor open they stay literal, like ${file} does.
  assert.equal(lin.substVars('${lineNumber}'), '${lineNumber}');
});

test('launchSpec: serverReadyAction becomes a pattern for the renderer to watch', () => {
  const spec = lin.launchSpec({ name: 'Web', type: 'node', program: 'server.js', serverReadyAction: { pattern: 'ready at (https?://\\S+)', uriFormat: '%s/app', action: 'openExternally' } });
  assert.deepEqual(spec.serverReady, { pattern: 'ready at (https?://\\S+)', uriFormat: '%s/app' });
  // Defaults match what most dev servers print.
  const dflt = lin.launchSpec({ name: 'W', type: 'node', program: 's.js', serverReadyAction: { action: 'openExternally' } });
  assert.equal(dflt.serverReady.uriFormat, '%s');
  // No action, or one that needs a real debugger: nothing to watch for.
  assert.equal(lin.launchSpec({ name: 'W', type: 'node', program: 's.js' }).serverReady, undefined);
  assert.equal(lin.launchSpec({ name: 'W', type: 'node', program: 's.js', serverReadyAction: { action: 'startDebugging' } }).serverReady, undefined);
});

test('buildLaunchCommand: python and debugpy map to python', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'python', program: 'main.py' }), 'python main.py');
  assert.equal(lin.buildLaunchCommand({ type: 'debugpy', program: 'main.py' }), 'python main.py');
});

test('buildLaunchCommand: debugpy module runs python -m', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'debugpy', module: 'mypkg.cli', args: ['talk', '--mic'] }),
    'python -m mypkg.cli talk --mic',
  );
});

test('buildLaunchCommand: debugpy uses the python/pythonPath interpreter and pythonArgs', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'debugpy', python: '${workspaceFolder}/.venv/bin/python', module: 'app' }),
    '/repo/.venv/bin/python -m app',
  );
  assert.equal(
    lin.buildLaunchCommand({ type: 'python', pythonPath: 'python3', program: 'main.py', pythonArgs: ['-u'] }),
    'python3 -u main.py',
  );
});

test('buildLaunchCommand: debugpy code runs python -c', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'debugpy', code: ['import app', 'app.main()'] }),
    'python -c "import app\napp.main()"',
  );
});

test('buildLaunchCommand: runtimeExecutable/runtimeArgs honoured', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'node', runtimeExecutable: 'tsx', runtimeArgs: ['--no-warnings'], program: 'a.ts' }),
    'tsx --no-warnings a.ts',
  );
});

test('buildLaunchCommand: go modes map to run/test/exec', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'go', program: 'main.go' }), 'go run main.go');
  assert.equal(lin.buildLaunchCommand({ type: 'go', mode: 'debug', program: 'main.go', buildFlags: '-tags=dev' }), 'go run -tags=dev main.go');
  assert.equal(lin.buildLaunchCommand({ type: 'go', mode: 'test' }), 'go test ./...');
  assert.equal(lin.buildLaunchCommand({ type: 'go', mode: 'test', program: './pkg', args: ['-run', 'TestX'] }), 'go test ./pkg -run TestX');
  assert.equal(lin.buildLaunchCommand({ type: 'go', mode: 'exec', program: './bin/app' }), './bin/app');
  assert.equal(lin.buildLaunchCommand({ type: 'go', mode: 'core', program: 'main.go' }), null);
});

test('buildLaunchCommand: node-terminal runs its command line verbatim', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'node-terminal', command: 'npm run dev -- --port 3000' }),
    'npm run dev -- --port 3000',
  );
  assert.equal(lin.buildLaunchCommand({ type: 'node-terminal' }), null);
});

test('buildLaunchCommand: java builds the classpath and honours string vmArgs/args', () => {
  assert.equal(
    lin.buildLaunchCommand({
      type: 'java',
      mainClass: 'com.example.App',
      vmArgs: '-Xmx512m -Dfoo=bar',
      classPaths: ['${workspaceFolder}/build', 'lib/a.jar'],
      args: 'one two',
    }),
    'java -Xmx512m -Dfoo=bar -cp /repo/build:lib/a.jar com.example.App one two',
  );
  // Single-file source launch: no mainClass, just the .java file.
  assert.equal(lin.buildLaunchCommand({ type: 'java', program: 'App.java' }), 'java App.java');
  assert.equal(lin.buildLaunchCommand({ type: 'java', request: 'attach' }), null);
});

// On Windows the separator is `;`, which PowerShell would read as a statement
// separator, so the joined list must arrive quoted.
test('buildLaunchCommand: java joins classpaths with the platform separator', () => {
  assert.equal(
    win.buildLaunchCommand({ type: 'java', mainClass: 'App', classPaths: ['build', 'lib.jar'] }),
    'java -cp "build;lib.jar" App',
  );
});

test('buildLaunchCommand: dotnet/coreclr runs the assembly through the dotnet host', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'coreclr', program: '${workspaceFolder}/bin/Debug/net8.0/App.dll' }),
    'dotnet exec /repo/bin/Debug/net8.0/App.dll',
  );
  assert.equal(lin.buildLaunchCommand({ type: 'coreclr', program: './bin/App' }), './bin/App'); // apphost
  assert.equal(
    lin.buildLaunchCommand({ type: 'dotnet', projectPath: '${workspaceFolder}/App.csproj', args: ['--verbose'] }),
    'dotnet run --project /repo/App.csproj -- --verbose',
  );
  assert.equal(lin.buildLaunchCommand({ type: 'coreclr', request: 'attach' }), null);
});

test('buildLaunchCommand: a cargo target becomes cargo run', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'lldb', cargo: { args: ['build', '--bin=server'] }, args: ['--port', '80'] }),
    'cargo run --bin=server -- --port 80',
  );
  // A test target: --no-run exists only so the debugger can launch the binary.
  assert.equal(
    lin.buildLaunchCommand({ type: 'lldb', cargo: { args: ['test', '--no-run', '--lib'] } }),
    'cargo test --lib',
  );
  assert.equal(lin.buildLaunchCommand({ type: 'lldb', cargo: { args: ['--bin=x'] } }), 'cargo run --bin=x');
});

test('buildLaunchCommand: dart and flutter', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'dart', program: 'bin/main.dart' }), 'dart run bin/main.dart');
  assert.equal(
    lin.buildLaunchCommand({ type: 'dart', program: 'lib/main.dart', flutterMode: 'profile', deviceId: 'chrome', toolArgs: ['--web-port=8080'] }),
    'flutter run --web-port=8080 --profile -d chrome -t lib/main.dart',
  );
  // debug is flutter's default mode, so it needs no flag.
  assert.equal(
    lin.buildLaunchCommand({ type: 'dart', program: 'lib/main.dart', flutterMode: 'debug' }),
    'flutter run -t lib/main.dart',
  );
  assert.equal(lin.buildLaunchCommand({ type: 'dart' }), null);
});

test('buildLaunchCommand: bun, powershell and extensionHost', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'bun', program: 'index.ts', args: ['--watch'] }), 'bun run index.ts --watch');
  assert.equal(lin.buildLaunchCommand({ type: 'PowerShell', script: '${workspaceFolder}/build.ps1', args: ['-Clean'] }), 'pwsh -File /repo/build.ps1 -Clean');
  assert.equal(lin.buildLaunchCommand({ type: 'PowerShell', script: 'Invoke-Build' }), 'pwsh -Command Invoke-Build');
  assert.equal(
    lin.buildLaunchCommand({ type: 'extensionHost', args: ['--extensionDevelopmentPath=${workspaceFolder}'] }),
    'code --extensionDevelopmentPath=/repo',
  );
});

test('buildLaunchCommand: rdbg, mix_task, R and lua-local', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'rdbg', script: 'main.rb' }), 'ruby main.rb');
  assert.equal(lin.buildLaunchCommand({ type: 'rdbg', command: 'rails', script: 'server', useBundler: true }), 'bundle exec rails server');
  assert.equal(lin.buildLaunchCommand({ type: 'mix_task', task: 'test', taskArgs: ['--trace'] }), 'mix test --trace');
  assert.equal(lin.buildLaunchCommand({ type: 'R-Debugger', debugMode: 'file', file: 'analysis.R' }), 'Rscript analysis.R');
  assert.equal(lin.buildLaunchCommand({ type: 'lua-local', program: { lua: 'lua5.3', file: 'main.lua' } }), 'lua5.3 main.lua');
  assert.equal(lin.buildLaunchCommand({ type: 'lua-local', program: { command: 'love', args: ['.'] } }), 'love .');
});

test('buildLaunchCommand: julia and mojo run through their interpreter', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'julia', program: 'src/main.jl' }), 'julia src/main.jl');
  assert.equal(lin.buildLaunchCommand({ type: 'mojo', program: 'hello.mojo' }), 'mojo hello.mojo');
});

test('buildLaunchCommand: gdb (Native Debug) runs its target with string arguments', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'gdb', target: './build/app', arguments: '--verbose -n 3' }),
    './build/app --verbose -n 3',
  );
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

test('buildLaunchCommand: returns null for an unrunnable config (attach/no program)', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'go' }), null); // TYPE_RUNTIME but no program
  assert.equal(lin.buildLaunchCommand({ type: 'chrome' }), null); // browser but no url/file
  // A node/python attach config (no program) must not become a bare REPL.
  assert.equal(lin.buildLaunchCommand({ type: 'node', request: 'attach', port: 9229 }), null);
  assert.equal(lin.buildLaunchCommand({ type: 'python', request: 'attach' }), null);
});

test('buildLaunchCommand: browser config opens its url with the OS opener', () => {
  const cfg = { type: 'chrome', url: 'http://localhost:5173' };
  assert.equal(win.buildLaunchCommand(cfg), 'Start-Process http://localhost:5173');
  assert.equal(mac.buildLaunchCommand(cfg), 'open http://localhost:5173');
  assert.equal(lin.buildLaunchCommand(cfg), 'xdg-open http://localhost:5173');
});

test('buildLaunchCommand: browser variants (msedge/pwa-chrome/firefox) and file targets', () => {
  assert.equal(lin.buildLaunchCommand({ type: 'pwa-chrome', url: 'http://x.test' }), 'xdg-open http://x.test');
  assert.equal(lin.buildLaunchCommand({ type: 'msedge', url: 'http://x.test' }), 'xdg-open http://x.test');
  // A `file` target (resolving ${workspaceFolder}) is opened when there's no url.
  assert.equal(
    lin.buildLaunchCommand({ type: 'firefox', file: '${workspaceFolder}/index.html' }),
    'xdg-open /repo/index.html',
  );
});

test('buildLaunchCommand: browser config honours an explicit runtimeExecutable', () => {
  assert.equal(
    lin.buildLaunchCommand({ type: 'chrome', runtimeExecutable: 'chromium', runtimeArgs: ['--incognito'], url: 'http://x.test' }),
    'chromium --incognito http://x.test',
  );
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

test('buildTaskCommand: npm task type runs the script', () => {
  assert.equal(lin.buildTaskCommand({ type: 'npm', script: 'build' }), 'npm run build');
  assert.equal(lin.buildTaskCommand({ type: 'npm' }), null); // no script -> nothing to run
});

test('buildTaskCommand: typescript task type maps to npx tsc', () => {
  assert.equal(lin.buildTaskCommand({ type: 'typescript', tsconfig: 'tsconfig.json' }), 'npx tsc -p tsconfig.json');
  assert.equal(lin.buildTaskCommand({ type: 'typescript', tsconfig: 'tsconfig.json', option: 'watch' }),
    'npx tsc -p tsconfig.json --watch');
});

test('buildTaskCommand: gulp/grunt/jake task types run via npx', () => {
  assert.equal(lin.buildTaskCommand({ type: 'gulp', task: 'clean' }), 'npx gulp clean');
  assert.equal(lin.buildTaskCommand({ type: 'grunt', task: 'dist' }), 'npx grunt dist');
  assert.equal(lin.buildTaskCommand({ type: 'jake' }), 'npx jake');
});

test('buildTaskCommand: { value, quoting: "strong" } args are always quoted', () => {
  assert.equal(
    lin.buildTaskCommand({ type: 'shell', command: 'echo', args: [{ value: 'nospace', quoting: 'strong' }, { value: 'plain' }] }),
    'echo "nospace" plain',
  );
});

test('buildTaskCommand: options.shell wraps the line in the custom shell', () => {
  assert.equal(
    lin.buildTaskCommand({ type: 'shell', command: 'echo hi', options: { shell: { executable: '/bin/zsh' } } }),
    '/bin/zsh -c "echo hi"',
  );
  assert.equal(
    lin.buildTaskCommand({ type: 'shell', command: 'dir', options: { shell: { executable: 'cmd.exe' } } }),
    'cmd.exe /d /c "dir"',
  );
  assert.equal(
    lin.buildTaskCommand({ type: 'shell', command: 'ls', options: { shell: { executable: 'pwsh', args: ['-NoProfile', '-Command'] } } }),
    'pwsh -NoProfile -Command "ls"',
  );
});

// The co-op LAN test task: a `bash foo.sh` process task with a `windows` override
// running `cmd.exe /c foo.bat`. Windows must use the override; macOS/Linux the base.
const coop = {
  label: 'Co-op test (host + client)',
  type: 'process',
  command: 'bash',
  args: ['${workspaceFolder}/tools/run_coop_lan_test.sh'],
  windows: { command: 'cmd.exe', args: ['/c', '${workspaceFolder}\\tools\\run_coop_lan_test.bat'] },
};

test('buildTaskCommand: applies the windows override on win32', () => {
  assert.equal(win.buildTaskCommand(coop), 'cmd.exe /c /repo\\tools\\run_coop_lan_test.bat');
});

test('buildTaskCommand: keeps the base command on macOS and Linux', () => {
  assert.equal(mac.buildTaskCommand(coop), 'bash /repo/tools/run_coop_lan_test.sh');
  assert.equal(lin.buildTaskCommand(coop), 'bash /repo/tools/run_coop_lan_test.sh');
});

test('buildTaskCommand: osx key wins on macOS, linux key on linux', () => {
  const t = { type: 'shell', command: 'base', osx: { command: 'mac' }, linux: { command: 'nix' } };
  assert.equal(mac.buildTaskCommand(t), 'mac');
  assert.equal(lin.buildTaskCommand(t), 'nix');
  assert.equal(win.buildTaskCommand(t), 'base'); // no windows key: falls back to base
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

test('resolveTask: platform override reaches the resolved spec (command + options)', () => {
  const t = {
    label: 'run', type: 'process', command: 'bash', args: ['x.sh'],
    options: { cwd: '${workspaceFolder}', env: { MODE: 'base' } },
    windows: { command: 'cmd.exe', args: ['/c', 'x.bat'], options: { env: { MODE: 'win' } } },
  };
  assert.deepEqual(win.resolveTask([t], t), [
    { command: 'cmd.exe /c x.bat', cwd: '/repo', env: { MODE: 'win' }, name: 'run' },
  ]);
  // macOS keeps the base command and env, override untouched.
  assert.deepEqual(mac.resolveTask([t], t), [
    { command: 'bash x.sh', cwd: '/repo', env: { MODE: 'base' }, name: 'run' },
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

test('resolveTask: npm task path sets the spec cwd (options.cwd still wins)', () => {
  const t = { label: 'web build', type: 'npm', script: 'build', path: 'packages/web' };
  assert.deepEqual(lin.resolveTask([t], t), [
    { command: 'npm run build', cwd: path.join(REPO, 'packages/web'), env: {}, name: 'web build' },
  ]);
  const t2 = { ...t, options: { cwd: '/elsewhere' } };
  assert.equal(lin.resolveTask([t2], t2)[0].cwd, '/elsewhere');
});

// --- normalizeTasks / prependTasks ---

test('normalizeTasks: global options fold onto tasks, task values win', () => {
  const json = {
    options: { cwd: '/g', env: { A: '1', B: 'base' } },
    tasks: [
      { label: 'a', command: 'x' },
      { label: 'b', command: 'y', options: { cwd: '/t', env: { B: 'task' } } },
    ],
  };
  const [a, b] = lin.normalizeTasks(json);
  assert.deepEqual(a.options, { cwd: '/g', env: { A: '1', B: 'base' } });
  assert.deepEqual(b.options, { cwd: '/t', env: { A: '1', B: 'task' } });
});

test('normalizeTasks: global platform block overrides global options', () => {
  const json = {
    options: { env: { MODE: 'base' } },
    windows: { options: { env: { MODE: 'win' } } },
    tasks: [{ label: 'a', command: 'x' }],
  };
  assert.equal(win.normalizeTasks(json)[0].options.env.MODE, 'win');
  assert.equal(lin.normalizeTasks(json)[0].options.env.MODE, 'base');
});

test('prependTasks: chains preLaunchTask steps before the launch command', () => {
  const taskSpecs = [{ command: 'npm run build', cwd: REPO, env: { A: '1' } }];
  const launch = { command: 'node app.js', cwd: REPO, env: { B: '2' }, name: 'Server' };
  assert.deepEqual(lin.prependTasks(taskSpecs, launch), [
    { command: 'npm run build && node app.js', cwd: REPO, env: { A: '1', B: '2' }, name: 'Server' },
  ]);
  // No tasks: the launch spec passes through untouched.
  assert.deepEqual(lin.prependTasks([], launch), [launch]);
});

test('prependTasks: a step (or the launch) in another cwd gets a cd prefix', () => {
  const taskSpecs = [{ command: 'make', cwd: '/repo/sub', env: {} }];
  const launch = { command: 'run', cwd: '/repo/app', env: {}, name: 'L' };
  assert.equal(
    lin.prependTasks(taskSpecs, launch)[0].command,
    "cd '/repo/sub' && make && cd '/repo/app' && run",
  );
});

// A watcher never exits, so chaining it would mean the launch never starts. VS
// Code doesn't wait for one either — its background problem matcher signals
// "ready" — so it gets its own terminal and the launch starts alongside.
test('prependTasks: a background preLaunchTask runs beside the launch, not before it', () => {
  const watch = { command: 'tsc -w', cwd: REPO, env: {}, name: 'watch', background: true };
  const build = { command: 'npm run build', cwd: REPO, env: {}, name: 'build' };
  const launch = { command: 'node app.js', cwd: REPO, env: {}, name: 'Server' };
  assert.deepEqual(lin.prependTasks([watch], launch), [watch, launch]);
  // A foreground step alongside it still gates the launch.
  const both = lin.prependTasks([watch, build], launch);
  assert.deepEqual(both[0], watch);
  assert.equal(both[1].command, 'npm run build && node app.js');
});

test('prependTasks: postDebugTask runs after the launch, whatever its exit code', () => {
  const launch = { command: 'node app.js', cwd: REPO, env: {}, name: 'Server' };
  const post = [{ command: 'docker compose down', cwd: REPO, env: {} }];
  assert.equal(
    lin.prependTasks([], launch, post)[0].command,
    'node app.js; docker compose down',
  );
  assert.equal(
    lin.prependTasks([{ command: 'make', cwd: REPO, env: {} }], launch, post)[0].command,
    'make && node app.js; docker compose down',
  );
});

test('resolveTask: a background task is marked so it is never chained', () => {
  const watch = { label: 'watch', type: 'shell', command: 'tsc -w', isBackground: true };
  const build = { label: 'build', type: 'shell', command: 'make' };
  const all = [watch, build];
  assert.equal(lin.resolveTask(all, watch)[0].background, true);
  assert.equal(lin.resolveTask(all, build)[0].background, undefined);
  // In a sequence the watcher is split out instead of stalling the chain.
  const seq = { label: 'all', dependsOn: ['watch', 'build'], dependsOrder: 'sequence' };
  const specs = lin.resolveTask([...all, seq], seq);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].name, 'watch');
  assert.equal(specs[1].command, 'make');
});

test('resolveTask: presentation rides along for the renderer', () => {
  const t = { label: 'x', command: 'run', presentation: { panel: 'new', reveal: 'never' } };
  assert.deepEqual(lin.resolveTask([t], t)[0].presentation, { panel: 'new', reveal: 'never' });
});

test('resolveTask: a single string dependsOn is accepted', () => {
  const a = { label: 'a', command: 'cmdA' };
  const comp = { label: 'all', dependsOn: 'a' };
  assert.deepEqual(lin.resolveTask([a, comp], comp).map((s) => s.command), ['cmdA']);
});
