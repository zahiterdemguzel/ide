// Pure, Electron-free rules for telling whether an agent session still has
// background work alive: a background Bash terminal (`run_in_background`) or a
// Monitor. Claude Code runs both as shell processes under the CLI, and no hook
// reports when they end, so the process tree supplies that signal to the
// session indicator and bulk clear.

// Process names that are shells. The agent's Bash and Monitor tools run their
// commands through one; MCP servers and the CLI itself are node/python/native
// binaries, so they don't count as background work.
const SHELL_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh',
  'cmd', 'powershell', 'pwsh',
]);

// The process listing command per platform. Each prints one `pid ppid name`
// line per process. The status indicator requests the full command line so it
// can distinguish Claude's tool shells from hook and MCP subprocesses.
function processListCommand(platform, { commandLine = false } = {}) {
  if (platform === 'win32') {
    const column = commandLine ? String.raw`$_.CommandLine -replace "[\r\n]", " "` : '$_.Name';
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(${column})" }`],
    };
  }
  if (commandLine) return { file: 'ps', args: ['-ww', '-A', '-o', 'pid=,ppid=,args='] };
  return { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,comm='] };
}

// Everything after the two IDs is the executable name or full command line.
function parseProcessList(text, { commandLine = false } = {}) {
  const processes = [];
  const column = commandLine ? 'commandLine' : 'name';
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.+?))?\s*$/.exec(line);
    if (match && (commandLine || match[3])) {
      processes.push({ pid: Number(match[1]), ppid: Number(match[2]), [column]: match[3] || '' });
    }
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

// Claude's shell tools write their final working directory to a per-call temp
// file. The wrapper stays alive for the command's whole run, including when the
// TUI backgrounds it. Hooks, status-line refreshes and MCP launches use other
// wrappers, so counting every child shell here would report activity at idle.
function hasClaudeToolShell(processes, rootPid) {
  return descendantsOf(processes, rootPid).some(({ commandLine }) => {
    if (/\bpwd -P >\| [^\r\n]*[/\\](?:claude-[\da-f]+-cwd|cwd-[\da-f]+)\b/.test(commandLine)) return true;
    const encoded = /\s-EncodedCommand\s+([a-z\d+/=]+)/i.exec(commandLine);
    const script = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : commandLine;
    return /\| Out-File -FilePath [^\r\n]*[/\\]claude-pwd-ps-[\da-f]+\b/.test(script);
  });
}

module.exports = {
  processListCommand, parseProcessList, baseProcessName, isShellProcess, descendantsOf, hasBackgroundWork, hasClaudeToolShell,
};
