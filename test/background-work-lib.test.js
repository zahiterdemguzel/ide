const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  processListCommand, parseProcessList, baseProcessName, isShellProcess, descendantsOf, hasBackgroundWork,
} = require('../src/main/background-work-lib');

test('parseProcessList: reads pid, ppid and a name that may contain spaces', () => {
  const text = '    1     0 /sbin/launchd\n  500     1 /Applications/My App.app/Contents/MacOS/My App\r\n\ngarbage\n';
  assert.deepEqual(parseProcessList(text), [
    { pid: 1, ppid: 0, name: '/sbin/launchd' },
    { pid: 500, ppid: 1, name: '/Applications/My App.app/Contents/MacOS/My App' },
  ]);
  assert.deepEqual(parseProcessList(''), []);
  assert.deepEqual(parseProcessList(undefined), []);
});

test('baseProcessName: strips the path, login dash and .exe', () => {
  assert.equal(baseProcessName('/bin/zsh'), 'zsh');
  assert.equal(baseProcessName('-zsh'), 'zsh');
  assert.equal(baseProcessName('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), 'bash');
  assert.equal(baseProcessName('PowerShell.EXE'), 'powershell');
});

test('isShellProcess: shells count, the CLI and MCP servers do not', () => {
  for (const name of ['/bin/zsh', 'bash', 'sh', 'cmd.exe', 'pwsh']) assert.equal(isShellProcess(name), true, name);
  for (const name of ['node', 'claude', 'python3', 'uvx', 'curl']) assert.equal(isShellProcess(name), false, name);
});

test('descendantsOf: walks the whole subtree, not the root or its siblings', () => {
  const processes = [
    { pid: 10, ppid: 1, name: 'claude' },
    { pid: 11, ppid: 10, name: 'node' },
    { pid: 12, ppid: 11, name: 'zsh' },
    { pid: 20, ppid: 1, name: 'zsh' },
  ];
  assert.deepEqual(descendantsOf(processes, 10).map((p) => p.pid), [11, 12]);
  assert.deepEqual(descendantsOf(processes, 99), []);
});

test('hasBackgroundWork: a shell below the CLI is a running terminal or monitor', () => {
  const idle = [
    { pid: 10, ppid: 1, name: '/bin/zsh' },
    { pid: 11, ppid: 10, name: 'claude' },
    { pid: 12, ppid: 11, name: 'node' },
    { pid: 30, ppid: 1, name: '/bin/zsh' },
  ];
  assert.equal(hasBackgroundWork(idle, 10), false, 'a wrapping PTY shell and an MCP server are not background work');
  const withMonitor = [...idle, { pid: 13, ppid: 11, name: '/bin/zsh' }, { pid: 14, ppid: 13, name: 'tail' }];
  assert.equal(hasBackgroundWork(withMonitor, 10), true);
});

test('processListCommand: ps on POSIX, PowerShell CIM on Windows', () => {
  assert.equal(processListCommand('darwin').file, 'ps');
  assert.equal(processListCommand('linux').file, 'ps');
  assert.equal(processListCommand('win32').file, 'powershell.exe');
});
