const path = require('path');
const { cleanEnv } = require('./proc-env');

// --- Language servers (LSP) — the Electron-free half ---
// The editor talks to real language servers over the Language Server Protocol.
// This module holds everything that doesn't touch a process, socket or window:
// wire framing, the registry of known servers, launch resolution (bundled vs found
// on PATH), the spawn environment, and the per-server workspace settings. lsp.js
// owns the processes/IPC; the renderer's editor/lsp-client.js speaks the protocol.

// ── Wire framing ────────────────────────────────────────────────────────────
// `Content-Length: <bytes>\r\n\r\n<json>`, same as DAP. The host forwards bodies to
// the renderer as raw JSON strings (it never needs to look inside), so the reader
// yields strings and the encoder accepts either a string or an object.
function encodeMessage(body) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, 'ascii'), bytes]);
}

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

// Incremental parser for a byte stream that may split or batch messages anywhere,
// including inside a header or a multi-byte UTF-8 character. A big completion list
// arrives in many 64 KB chunks, so chunks are queued and only joined once a whole
// body is present (a concat per chunk would be quadratic in the message size).
function createMessageReader(onBody) {
  let chunks = [];
  let buffered = 0;
  let bodyLength = -1; // -1 while still reading a header

  function take(n) {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    chunks = rest.length ? [rest] : [];
    buffered = rest.length;
    return head;
  }

  function peekAll() {
    if (chunks.length > 1) chunks = [Buffer.concat(chunks, buffered)];
    return chunks[0] || Buffer.alloc(0);
  }

  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (!buf.length) return;
      chunks.push(buf);
      buffered += buf.length;
      for (;;) {
        if (bodyLength < 0) {
          const headerEnd = peekAll().indexOf(HEADER_END);
          if (headerEnd < 0) return;
          const header = take(headerEnd + HEADER_END.length).toString('ascii');
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) continue; // junk header (e.g. a stray log line): skip it
          bodyLength = Number(match[1]);
        }
        if (buffered < bodyLength) return; // wait for the rest of the body
        const body = take(bodyLength).toString('utf8');
        bodyLength = -1;
        onBody(body);
      }
    },
  };
}

// ── Server registry ─────────────────────────────────────────────────────────
// One row per language server. `languages` are Monaco language ids. `launch` lists
// the ways to start it, tried in order; the first one available wins:
//   { bundledScript, args }  — a Node script shipped in node_modules, run with the
//                              app's own Electron binary as Node (ELECTRON_RUN_AS_NODE)
//   { bundledBinary, args }  — a native executable shipped in node_modules;
//                              bundledBinary(platform, arch) → its node_modules path
//   { command, args }        — an executable found on PATH (or the common install
//                              dirs a GUI-launched app's minimal PATH misses)
//   { tcp: { host, port } }  — an already-running server listening on a socket
// `requires` on a launch is an extra precondition (see launchPrerequisite).
// `install` is the hint shown when nothing is found.
//
// To add a server: add a row here (and, if Monaco has no language id for its files,
// register one in the editor host). Nothing else is server-specific unless it needs
// workspace settings (serverSettings below) or initializationOptions.
const SERVERS = [
  {
    id: 'pyright', name: 'Pyright', languages: ['python'],
    launch: [{ bundledScript: 'pyright/langserver.index.js', args: ['--stdio'] }],
  },
  {
    // TypeScript 7 is the native (Go) compiler and has a built-in LSP mode, so it
    // replaces typescript-language-server + tsserver.js (which TS 7 no longer ships).
    // typescript-language-server stays as the fallback for a platform without the
    // native binary, using the project's own pre-7 TypeScript.
    id: 'typescript', name: 'TypeScript', languages: ['typescript', 'javascript'],
    launch: [
      { bundledBinary: (platform, arch) => `@typescript/typescript-${platform}-${arch}/lib/tsc${platform === 'win32' ? '.exe' : ''}`, args: ['--lsp', '--stdio'] },
      { bundledScript: 'typescript-language-server/lib/cli.mjs', args: ['--stdio'], requires: 'tsserver', name: 'typescript-language-server' },
    ],
  },
  { id: 'gopls', name: 'gopls', languages: ['go'], launch: [{ command: 'gopls' }], install: 'go install golang.org/x/tools/gopls@latest' },
  { id: 'rust-analyzer', name: 'rust-analyzer', languages: ['rust'], launch: [{ command: 'rust-analyzer' }], install: 'rustup component add rust-analyzer' },
  {
    id: 'clangd', name: 'clangd', languages: ['c', 'cpp', 'objective-c', 'objective-cpp'],
    launch: [{ command: 'clangd' }, { command: 'xcrun', args: ['clangd'], platforms: ['darwin'] }],
    install: 'install clangd (LLVM) or Xcode Command Line Tools',
  },
  {
    id: 'sourcekit-lsp', name: 'SourceKit-LSP', languages: ['swift'],
    launch: [{ command: 'sourcekit-lsp' }, { command: 'xcrun', args: ['sourcekit-lsp'], platforms: ['darwin'] }],
    install: 'install Xcode or a Swift toolchain',
  },
  {
    id: 'csharp', name: 'C#', languages: ['csharp'],
    launch: [{ command: 'csharp-ls', name: 'csharp-ls' }, { command: 'OmniSharp', args: ['-lsp'], name: 'OmniSharp' }, { command: 'omnisharp', args: ['-lsp'], name: 'OmniSharp' }],
    install: 'dotnet tool install --global csharp-ls',
  },
  {
    // jdtls insists on a writable per-project data directory outside the project.
    id: 'jdtls', name: 'Eclipse JDT LS', languages: ['java'],
    launch: [{ command: 'jdtls', args: ['-data', '${workspaceCache}'] }],
    install: 'brew install jdtls',
  },
  { id: 'lua-language-server', name: 'Lua Language Server', languages: ['lua'], launch: [{ command: 'lua-language-server' }], install: 'brew install lua-language-server' },
  {
    id: 'ruby', name: 'Ruby', languages: ['ruby'],
    launch: [{ command: 'ruby-lsp', name: 'Ruby LSP' }, { command: 'solargraph', args: ['stdio'], name: 'Solargraph' }],
    install: 'gem install ruby-lsp',
  },
  { id: 'intelephense', name: 'Intelephense', languages: ['php'], launch: [{ command: 'intelephense', args: ['--stdio'] }], install: 'npm install -g intelephense' },
  { id: 'kotlin-language-server', name: 'Kotlin Language Server', languages: ['kotlin'], launch: [{ command: 'kotlin-language-server' }], install: 'brew install kotlin-language-server' },
  { id: 'bash-language-server', name: 'Bash Language Server', languages: ['shell'], launch: [{ command: 'bash-language-server', args: ['start'] }], install: 'npm install -g bash-language-server' },
  { id: 'yaml-language-server', name: 'YAML Language Server', languages: ['yaml'], launch: [{ command: 'yaml-language-server', args: ['--stdio'] }], install: 'npm install -g yaml-language-server' },
  { id: 'dart', name: 'Dart Analysis Server', languages: ['dart'], launch: [{ command: 'dart', args: ['language-server'] }], install: 'install the Dart or Flutter SDK' },
  { id: 'zls', name: 'ZLS', languages: ['zig'], launch: [{ command: 'zls' }], install: 'install zls (https://github.com/zigtools/zls)' },
  {
    id: 'elixir-ls', name: 'ElixirLS', languages: ['elixir'],
    launch: [{ command: 'elixir-ls' }, { command: 'language_server.sh' }],
    install: 'brew install elixir-ls',
  },
  { id: 'haskell-language-server', name: 'Haskell Language Server', languages: ['haskell'], launch: [{ command: 'haskell-language-server-wrapper', args: ['--lsp'] }], install: 'ghcup install hls' },
  { id: 'metals', name: 'Metals', languages: ['scala'], launch: [{ command: 'metals' }], install: 'cs install metals' },
  { id: 'docker-langserver', name: 'Dockerfile Language Server', languages: ['dockerfile'], launch: [{ command: 'docker-langserver', args: ['--stdio'] }], install: 'npm install -g dockerfile-language-server-nodejs' },
  { id: 'terraform-ls', name: 'Terraform LS', languages: ['hcl', 'terraform'], launch: [{ command: 'terraform-ls', args: ['serve'] }], install: 'brew install hashicorp/tap/terraform-ls' },
  {
    // The Godot editor serves GDScript intelligence itself, on a TCP port, while
    // the project is open in it — there is nothing to spawn.
    id: 'godot', name: 'Godot', languages: ['gdscript'],
    launch: [{ tcp: { host: '127.0.0.1', port: 6005 } }],
    unavailable: 'Open this project in the Godot editor to enable GDScript intelligence (it serves the language server on port 6005).',
  },
];

function serverForLanguage(languageId) {
  return SERVERS.find((s) => s.languages.includes(languageId)) || null;
}

// Stable identity of a running server: one process per (server, project root).
function serverKey(serverId, root) {
  return `${serverId}@${root || ''}`;
}

// ── Launch resolution ───────────────────────────────────────────────────────
// Everything that touches the disk or the environment is injected through `ctx`:
//   which(cmd)        → absolute path of an executable, or null
//   bundled(relPath)  → absolute path of a node_modules file that exists, or null
//   exists(absPath)   → boolean
//   execPath, platform, arch, root, cacheDir
// Returns a launch plan, or { ok: false, reason } when the language has no server
// or none of its launches is available.
function resolveLaunch(languageId, ctx) {
  const server = serverForLanguage(languageId);
  if (!server) return { ok: false, unknown: true, reason: `No language server is known for "${languageId}".` };
  for (const launch of server.launch) {
    if (launch.platforms && !launch.platforms.includes(ctx.platform)) continue;
    const plan = planFor(server, launch, ctx);
    if (plan) return plan;
  }
  const reason = server.unavailable
    || `${server.name} was not found.${server.install ? ` Install it (${server.install}) and reopen the file.` : ''}`;
  return { ok: false, serverId: server.id, name: server.name, reason };
}

function planFor(server, launch, ctx) {
  const base = { ok: true, serverId: server.id, name: launch.name || server.name, languages: server.languages };
  if (launch.tcp) {
    return { ...base, source: 'tcp', transport: 'tcp', host: launch.tcp.host, port: launch.tcp.port, unreachable: server.unavailable };
  }

  const prerequisite = launchPrerequisite(launch, ctx);
  if (prerequisite === null) return null;
  const args = (launch.args || []).map((a) => substituteArg(a, server, ctx));

  if (launch.bundledScript) {
    const script = ctx.bundled(launch.bundledScript);
    if (!script) return null;
    return { ...base, source: 'bundled', transport: 'stdio', command: ctx.execPath, args: [script, ...args], runAsNode: true, ...prerequisite };
  }
  if (launch.bundledBinary) {
    const binary = ctx.bundled(launch.bundledBinary(ctx.platform, ctx.arch));
    if (!binary) return null;
    return { ...base, source: 'bundled', transport: 'stdio', command: binary, args, runAsNode: false, ...prerequisite };
  }
  const command = ctx.which(launch.command);
  if (!command) return null;
  return { ...base, source: 'path', transport: 'stdio', command, args, runAsNode: false, ...prerequisite };
}

// Extra conditions a launch needs beyond its own executable. Returns the plan fields
// the condition contributes ({} when there's nothing to add), or null when unmet.
function launchPrerequisite(launch, ctx) {
  if (launch.requires !== 'tsserver') return {};
  // typescript-language-server drives tsserver.js: the project's own TypeScript
  // first (matches what the project builds with), then a bundled one if present.
  const local = ctx.root ? path.join(ctx.root, 'node_modules', 'typescript', 'lib', 'tsserver.js') : null;
  const tsserver = (local && ctx.exists(local) && local) || ctx.bundled('typescript/lib/tsserver.js');
  if (!tsserver) return null;
  return { initializationOptions: { tsserver: { path: tsserver }, hostInfo: 'claude-session-editor' } };
}

function substituteArg(arg, server, ctx) {
  if (arg !== '${workspaceCache}') return arg;
  return path.join(ctx.cacheDir || '', server.id, hashString(ctx.root || 'no-root'));
}

// Short stable hash so each project gets its own cache dir without putting the
// whole (possibly very long) project path into a directory name.
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ── Finding executables ─────────────────────────────────────────────────────
// A macOS app launched from Finder/Dock inherits launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so gopls, rust-analyzer, Homebrew tools… are all
// invisible. The host merges the user's login-shell PATH (see parseLoginShellPath)
// with these well-known install dirs before searching.
function extraSearchDirs({ home, platform, env = {} }) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(appData, 'npm'),
      join(home, '.cargo', 'bin'),
      join(home, 'go', 'bin'),
      join(home, '.dotnet', 'tools'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      join(home, '.local', 'bin'),
    ];
  }
  const dirs = [
    env.GOPATH && join(env.GOPATH, 'bin'),
    join(home, 'go', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.dotnet', 'tools'),
    join(home, '.ghcup', 'bin'),
    join(home, '.pub-cache', 'bin'),
    join(home, '.local', 'share', 'coursier', 'bin'),
    join(home, 'Library', 'Application Support', 'Coursier', 'bin'),
    join(home, '.rbenv', 'shims'),
    join(home, '.asdf', 'shims'),
    '/usr/bin',
    '/bin',
  ];
  if (platform === 'darwin') dirs.push('/Library/Developer/CommandLineTools/usr/bin');
  return dirs.filter(Boolean);
}

// The ordered, de-duplicated directory list to search: the inherited PATH, then the
// login shell's PATH, then the well-known install dirs.
function searchDirs({ envPath, loginShellPath, extra, platform }) {
  const sep = platform === 'win32' ? ';' : ':';
  const all = [envPath, loginShellPath]
    .flatMap((p) => (p ? p.split(sep) : []))
    .concat(extra || [])
    .map((d) => d.trim())
    .filter(Boolean);
  return [...new Set(all)];
}

// First `name` (with a PATHEXT extension on Windows) that `isFile` accepts in `dirs`.
function findExecutable(name, dirs, { platform, isFile, pathext }) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const extensions = platform === 'win32'
    ? ['', ...(pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  const candidates = isAbsolute(name) ? [name] : dirs.map((d) => join(d, name));
  for (const candidate of candidates) {
    for (const ext of extensions) {
      if (isFile(candidate + ext)) return candidate + ext;
    }
  }
  return null;
}

// The login shell prints its PATH between markers so that rc-file noise (motd,
// nvm banners, …) around it can't be mistaken for part of it.
const SHELL_PATH_MARKER = '__LSP_PATH__';
function loginShellPathCommand() {
  return `printf '%s%s%s' '${SHELL_PATH_MARKER}' "$PATH" '${SHELL_PATH_MARKER}'`;
}
function parseLoginShellPath(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf(SHELL_PATH_MARKER);
  const end = text.indexOf(SHELL_PATH_MARKER, start + SHELL_PATH_MARKER.length);
  if (start < 0 || end < 0) return null;
  return text.slice(start + SHELL_PATH_MARKER.length, end) || null;
}

// ── Spawning ────────────────────────────────────────────────────────────────

// Packaged builds keep node_modules inside app.asar, but a child process can't
// execute or `require` from inside the archive — those packages are listed in
// build.asarUnpack and live under app.asar.unpacked instead.
function unpackedPath(p) {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

// The child's environment: scrubbed of debugger pollution (proc-env), with the
// merged PATH so a server can find its own toolchain (gopls needs `go`,
// rust-analyzer needs `cargo`), and — for a bundled Node script — the switch that
// makes the Electron binary behave as plain Node.
function serverEnv(baseEnv, { runAsNode, path: searchPath, platform }) {
  const env = cleanEnv(baseEnv);
  if (searchPath) {
    // Windows env keys are case-insensitive but a JS object isn't: reuse the
    // existing key ("Path" is common) so we don't end up with two.
    const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path') : 'PATH';
    env[key] = searchPath;
  }
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

// Node refuses to spawn a .cmd/.bat directly on Windows (CVE-2024-27980) — npm
// global installs are exactly that — so those go through the shell, quoted.
function spawnInvocation(command, args, platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return { command: quote(command), args: args.map(quote), shell: true };
  }
  return { command, args, shell: false };
}

// ── Workspace settings ──────────────────────────────────────────────────────

// The project's virtualenv interpreter, if it has one, so Pyright resolves the
// project's installed packages instead of reporting every import as missing.
function findVenvPython(root, platform, exists) {
  if (!root) return null;
  for (const dir of ['.venv', 'venv', 'env']) {
    const candidate = platform === 'win32'
      ? path.win32.join(root, dir, 'Scripts', 'python.exe')
      : path.posix.join(root, dir, 'bin', 'python');
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Settings the client hands back for `workspace/configuration` (and pushes once in
// `workspace/didChangeConfiguration`), keyed by dotted section like VS Code's.
function serverSettings(serverId, { pythonPath } = {}) {
  if (serverId === 'pyright') {
    return {
      python: {
        ...(pythonPath ? { pythonPath } : {}),
        analysis: {
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
          diagnosticMode: 'openFilesOnly',
          typeCheckingMode: 'standard',
          autoImportCompletions: true,
        },
      },
    };
  }
  if (serverId === 'typescript') {
    const inlayHints = {
      parameterNames: { enabled: 'literals', suppressWhenArgumentMatchesName: true },
      parameterTypes: { enabled: false },
      variableTypes: { enabled: false, suppressWhenTypeMatchesName: true },
      propertyDeclarationTypes: { enabled: true },
      functionLikeReturnTypes: { enabled: true },
      enumMemberValues: { enabled: true },
    };
    return { typescript: { inlayHints }, javascript: { inlayHints } };
  }
  return {};
}

module.exports = {
  encodeMessage, createMessageReader,
  SERVERS, serverForLanguage, serverKey, resolveLaunch,
  extraSearchDirs, searchDirs, findExecutable, loginShellPathCommand, parseLoginShellPath,
  unpackedPath, serverEnv, spawnInvocation,
  findVenvPython, serverSettings,
};
