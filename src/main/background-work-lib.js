// Pure, Electron-free rules for telling whether an agent session still has
// background work alive: a background Bash terminal (`run_in_background`) or a
// Monitor. Claude Code runs both as shell processes under the CLI, and no hook
// reports when they end, so the process tree is the source of truth. Archiving
// kills the CLI and every child with it, so the sidebar's bulk "clear" must skip
// a session that still owns one.

// Process names that are shells. The agent's Bash and Monitor tools run their
// commands through one; MCP servers and the CLI itself are node/python/native
// binaries, so they don't count as background work.
const SHELL_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh',
  'cmd', 'powershell', 'pwsh',
]);

// The process listing command per platform. Each prints one `pid ppid name`
// line per process.
function processListCommand(platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
    };
  }
  return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,comm='] };
}

// Parse `pid ppid name` lines. The name may be a full path containing spaces
// (macOS `comm`), so everything after the second column is the name.
function parseProcessList(text) {
  const processes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] });
  }
  return processes;
}

// `/bin/zsh` → `zsh`, `-zsh` (login shell) → `zsh`, `bash.exe` → `bash`.
function baseProcessName(name) {
  const last = String(name).split(/[\\/]/).pop();
  return last.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
}

function isShellProcess(name) {
  return SHELL_NAMES.has(baseProcessName(name));
}

// Every process below `rootPid` (not the root itself — on some platforms the
// PTY's own process is a shell wrapping the CLI).
function descendantsOf(processes, rootPid) {
  const childrenByParent = new Map();
  for (const proc of processes) {
    if (!childrenByParent.has(proc.ppid)) childrenByParent.set(proc.ppid, []);
    childrenByParent.get(proc.ppid).push(proc);
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of childrenByParent.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function hasBackgroundWork(processes, rootPid) {
  return descendantsOf(processes, rootPid).some((proc) => isShellProcess(proc.name));
}

module.exports = {
  processListCommand, parseProcessList, baseProcessName, isShellProcess, descendantsOf, hasBackgroundWork,
};
