// Pure VS Code launch.json/tasks.json -> shell-command translation. No electron,
// no file IO, no live editor context: the repo path (and platform, for the
// sequence chain operator) are passed in rather than read from a global. That
// keeps this unit-testable — run-configs.js owns the IPC handlers, file reads,
// and the .vscode watcher and calls into here. (Same split as edit-ops.js vs
// session-commit.js.)
const path = require('path');

// Parse JSONC (VS Code config files allow // and /* */ comments and trailing
// commas). Strip comments outside of strings, drop trailing commas, JSON.parse.
function parseJsonc(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Debug `type`s whose interpreter is the type's own runtime, so a config with a
// `program` but no explicit `runtimeExecutable` still resolves (e.g. a `php` config
// -> `php <program>`). Types needing more than "prefix the runtime" (node, python,
// go, java, …) have their own builder in buildLaunchCommand.
const TYPE_RUNTIME = {
  php: ['php'],
  ruby: ['ruby'],
  rdebug: ['ruby'],
  perl: ['perl'],
  lua: ['lua'],
  julia: ['julia'],
  mojo: ['mojo'],
  bashdb: ['bash'],
  shell: ['bash'],
};

// Browser debug `type`s (Chrome/Edge/Firefox and their VS Code `pwa-`/`vscode-`
// variants). They carry no `program`; their intent is to open a `url` (or local
// `file`), so we translate them to an OS "open" command rather than rejecting them.
// The dev server they point at is expected to be started separately (VS Code uses
// a preLaunchTask/compound), exactly as it would be there.
const BROWSER_TYPES = new Set([
  'chrome', 'msedge', 'edge', 'firefox',
  'pwa-chrome', 'pwa-msedge', 'pwa-firefox',
  'vscode-edge-devtools.debug',
]);

// Per-platform command that opens a URL/path in the default handler (browser).
const OPEN_CMD = { win32: ['Start-Process'], darwin: ['open'], linux: ['xdg-open'] };

// Quote an argument that would otherwise be split by the shell. Already-quoted
// values pass through untouched so a caller that had to quote earlier (a Windows
// `;`-joined classpath) isn't double-wrapped.
const quoteArg = (a) => {
  a = String(a);
  if (/^".*"$/.test(a)) return a;
  return /\s/.test(a) ? `"${a}"` : a;
};

// Several adapters accept a list attribute as either an array or a single
// space-separated string (Java's `vmArgs`/`args`, Go's `buildFlags`, Native
// Debug's `arguments`). Normalize so every builder can just map over it.
function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  return s ? s.split(/\s+/) : [];
}

// Build-tool wrappers ship an extensionless Unix script (used as a launch
// `runtimeExecutable`) next to a Windows variant. PowerShell can't run the
// extensionless file inline — Windows shell-executes it by file association,
// spawning an external window — so on win32 we point at the proper variant.
const WIN_WRAPPER_EXT = { mvnw: '.cmd', gradlew: '.bat' };

// Parse a `.env`-style envFile (VS Code launch `envFile`): KEY=VALUE per line,
// `#` comments and blanks skipped, optional `export ` prefix, optional matching
// surrounding quotes stripped. Pure (no file IO) so it lives here and is tested;
// run-configs.js reads the file and feeds the text in.
function parseEnvFile(text) {
  const env = {};
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// Build the command/spec translators bound to one repo path + platform. Created
// fresh per IPC call so it always sees the current open folder.
// Member config names of a launch.json compound (`configurations` entries may be
// plain names or { name } objects). The run toolbar uses these to tell whether a
// compound is "running" — i.e. any of its referenced configs' terminals is alive.
function compoundMembers(compound) {
  return ((compound && compound.configurations) || [])
    .map((ref) => (ref && typeof ref === 'object') ? ref.name : ref)
    .filter(Boolean);
}

// The toolbar's entries: launch configs + compounds, then task labels. Entries a
// user hid in VS Code (task `hide`, launch/compound `presentation.hidden`) stay
// hidden here too, and `presentation.order` sorts the visible ones.
//
// Names are unique within each list, first occurrence wins: a run is started and
// stopped *by name* (run-config-start / stopConfigNamed), so a second entry with a
// name already taken can never be addressed separately — showing it would offer a
// button that runs the first one.
// VS Code auto-detects a task per package.json script even with no tasks.json at
// all, labelled `npm: <script>`. Many projects ship no tasks.json, so without this
// their toolbar would be empty here while VS Code shows every script. A tasks.json
// entry with the same label still wins (that's how VS Code lets you customize a
// detected task) — listRunConfigs adds these last and its dedupe drops the rest.
const npmTaskLabel = (script) => `npm: ${script}`;

// The task definition behind an auto-detected `npm: <script>` button. Returns null
// for any other name, so the caller can fall through to "task not found".
function autoDetectedNpmTask(name) {
  const m = /^npm: (.+)$/.exec(String(name || ''));
  return m ? { type: 'npm', script: m[1], label: name } : null;
}

function listRunConfigs(launchJson, tasksJson, npmScripts) {
  const isHidden = (c) => !!(c && c.presentation && c.presentation.hidden);
  const orderOf = (c) => (c && c.presentation && typeof c.presentation.order === 'number') ? c.presentation.order : Infinity;
  const byOrder = (a, b) => orderOf(a) - orderOf(b);

  const launch = [];
  const tasks = [];
  const seen = new Set();
  const take = (list, name, entry) => {
    const key = `${list === launch ? 'l' : 't'}:${name}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    list.push(entry);
  };

  if (launchJson) {
    for (const c of [...(launchJson.configurations || [])].sort(byOrder)) {
      if (c && !isHidden(c)) take(launch, c.name, { name: c.name });
    }
    for (const c of [...(launchJson.compounds || [])].sort(byOrder)) {
      if (c && !isHidden(c)) take(launch, c.name, { name: c.name, compound: true, members: compoundMembers(c) });
    }
  }
  if (tasksJson) {
    for (const t of (tasksJson.tasks || [])) {
      if (t && !t.hide) take(tasks, t.label || t.taskName, { name: t.label || t.taskName });
    }
  }
  for (const script of (npmScripts || [])) take(tasks, npmTaskLabel(script), { name: npmTaskLabel(script) });
  return { launch, tasks };
}

// Scan every string a run spec puts on the command line for a `${<prefix>:id}`
// placeholder that survived substitution, and return the distinct ids.
function scanSpecs(specs, prefix) {
  const re = new RegExp(`\\$\\{${prefix}:([^}]+)\\}`, 'g');
  const ids = new Set();
  const scan = (s) => {
    if (typeof s !== 'string') return;
    for (const m of s.matchAll(re)) ids.add(m[1]);
  };
  for (const spec of specs || []) {
    scan(spec.command); scan(spec.cwd);
    for (const v of Object.values(spec.env || {})) scan(v);
  }
  return [...ids];
}

// Unresolved ${input:id}s — the ids the caller must collect values for (VS Code's
// `inputs`) before the run can start.
const findInputIds = (specs) => scanSpecs(specs, 'input');

// Unresolved ${command:id}s. VS Code runs an extension command to produce these
// (`${command:cmake.launchTargetPath}`, `${command:pickProcess}`, …), which we
// have no extension host for. Rather than run a command line with the literal
// placeholder still in it, the caller asks the user for the value — so these are
// reported alongside the inputs.
const findCommandIds = (specs) => scanSpecs(specs, 'command');

// Label of the default build task (`group: "build"` with isDefault, or the first
// plain `"build"` group). Backs the ${defaultBuildTask} variable and lets a
// launch config say `"preLaunchTask": "${defaultBuildTask}"`.
function defaultBuildTaskName(tasks) {
  const isBuild = (g) => g === 'build' || (g && typeof g === 'object' && g.kind === 'build');
  const flagged = (tasks || []).find((t) => t.group && typeof t.group === 'object' && t.group.kind === 'build' && t.group.isDefault);
  const any = flagged || (tasks || []).find((t) => isBuild(t.group));
  return any ? (any.label || any.taskName) : undefined;
}

// Shell args VS Code implies when a task's `options.shell.executable` is given
// without explicit args: the flag that makes that shell run one command line.
function defaultShellArgs(exe) {
  const base = path.basename(String(exe)).toLowerCase();
  if (base.includes('powershell') || base.includes('pwsh')) return ['-Command'];
  if (base.includes('cmd')) return ['/d', '/c'];
  return ['-c'];
}

// `ctx` supplies what pure translation can't know on its own — all optional:
//   home             ${userHome}
//   settings         .vscode/settings.json object, for ${config:dotted.key}
//   defaultBuildTask label backing ${defaultBuildTask}
//   inputs           { id: value } answers, for ${input:id}
//   activeFile       absolute path of the file open in the editor, for the
//                    ${file}/${fileBasename}/${relativeFile}/… family
function makeRunConfigLib(repoPath, platform = process.platform, ctx = {}) {
  // VS Code lets a task or launch config override `command`/`args`/`options`
  // (and program/runtimeExecutable/env/…) under a platform key — `windows` on
  // win32, `osx` on macOS, `linux` elsewhere — with the override winning per
  // property. `mergePlatform` folds the active platform's block onto the base so
  // the rest of the translator only ever sees resolved fields. This is what lets
  // a task run `cmd.exe /c foo.bat` on Windows but `bash foo.sh` on macOS/Linux.
  const PLATFORM_KEY = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  function mergePlatform(obj) {
    const over = obj && obj[PLATFORM_KEY];
    if (!over || typeof over !== 'object') return obj;
    const merged = { ...obj, ...over };
    // options is itself an object (cwd/env): shallow-merge so a platform override
    // of one key (e.g. env) doesn't drop the base's cwd, and vice versa.
    if (obj.options || over.options) merged.options = { ...obj.options, ...over.options };
    return merged;
  }

  // The ${file}-family variables, derived from ctx.activeFile when one is open.
  function fileVars() {
    const af = ctx.activeFile;
    if (!af) return null;
    const dir = path.dirname(af);
    const base = path.basename(af);
    const ext = path.extname(af);
    return {
      file: af,
      fileBasename: base,
      fileBasenameNoExtension: base.slice(0, base.length - ext.length),
      fileExtname: ext,
      fileDirname: dir,
      fileDirnameBasename: path.basename(dir),
      relativeFile: path.relative(repoPath, af),
      relativeFileDirname: path.relative(repoPath, dir),
      fileWorkspaceFolder: repoPath,
    };
  }

  // Resolve the VS Code variables we can. ${input:id} resolves from ctx.inputs
  // when the caller has collected an answer; otherwise it (like ${command:...},
  // or ${file} with no open editor) is left untouched — best effort, and the
  // leftover ${input:...}s are how findInputIds knows what still needs asking.
  function substVars(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (m, key) => {
      switch (key) {
        case 'workspaceFolder': case 'workspaceRoot': case 'cwd': return repoPath;
        case 'workspaceFolderBasename': return path.basename(repoPath);
        case 'pathSeparator': case '/': return path.sep;
        case 'userHome': return ctx.home != null ? ctx.home : m;
        case 'defaultBuildTask': return ctx.defaultBuildTask != null ? ctx.defaultBuildTask : m;
        case 'execPath': return ctx.execPath != null ? ctx.execPath : m;
        case 'lineNumber': return ctx.lineNumber != null ? String(ctx.lineNumber) : m;
        case 'columnNumber': return ctx.columnNumber != null ? String(ctx.columnNumber) : m;
        case 'selectedText': return ctx.selectedText != null ? ctx.selectedText : m;
      }
      // Multi-root `${workspaceFolder:name}`: we only ever have one folder open,
      // so the named form resolves to it rather than staying literal (which would
      // put a `${…}` on the command line).
      if (key.startsWith('workspaceFolder:') || key.startsWith('workspaceRoot:')) return repoPath;
      if (key.startsWith('env:')) return process.env[key.slice(4)] || '';
      if (key.startsWith('config:')) {
        const v = (ctx.settings || {})[key.slice(7)]; // settings.json keys are literal dotted strings
        return v == null ? '' : String(v);
      }
      if (key.startsWith('input:')) {
        const v = (ctx.inputs || {})[key.slice(6)];
        return v == null ? m : String(v);
      }
      // A `${command:id}` answer is collected under its full key, so it can't
      // collide with an `${input:id}` of the same name.
      if (key.startsWith('command:')) {
        const v = (ctx.inputs || {})[key];
        return v == null ? m : String(v);
      }
      const fv = fileVars();
      if (fv && key in fv) return fv[key];
      return m;
    });
  }

  // On Windows, rewrite an extensionless build-tool wrapper (mvnw/gradlew) to its
  // .cmd/.bat variant so the shell runs it directly instead of shell-executing the
  // Unix script into an external window. No-op off win32 or when already suffixed.
  function winExe(p) {
    if (platform !== 'win32' || !p) return p;
    const base = path.basename(p);
    const ext = WIN_WRAPPER_EXT[base.toLowerCase()];
    return ext && !path.extname(base) ? p + ext : p;
  }

  function envMap(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) out[k] = substVars(String(v));
    return out;
  }

  // Python (`python`/`debugpy`) launch configs name their target three ways:
  // `program` (a script), `module` (`-m pkg.cli`) or `code` (`-c "…"`, which may
  // arrive as an array of lines). The interpreter comes from the python-specific
  // `python`/`pythonPath` keys as often as from `runtimeExecutable`, and
  // `pythonArgs` are interpreter flags that must precede the target. Returns null
  // when none of the three targets is present and there's no explicit interpreter
  // — that's the attach shape, and running a bare REPL would be worse than saying so.
  function buildPythonParts(cfg, { program, args, runExe, runArgs }) {
    const exe = runExe
      || (cfg.python ? winExe(substVars(cfg.python)) : '')
      || (cfg.pythonPath ? winExe(substVars(cfg.pythonPath)) : '')
      || 'python';
    const pyArgs = [...(cfg.pythonArgs || []).map(substVars), ...runArgs];
    const mod = cfg.module ? substVars(cfg.module) : '';
    const code = Array.isArray(cfg.code) ? cfg.code.map(substVars).join('\n')
      : cfg.code ? substVars(cfg.code) : '';
    if (mod) return [exe, ...pyArgs, '-m', mod, ...args];
    if (code) return [exe, ...pyArgs, '-c', code, ...args];
    if (program || runExe || cfg.python || cfg.pythonPath) return [exe, ...pyArgs, program, ...args];
    return null;
  }

  // Java's `classPaths`/`modulePaths` are joined with the *target* platform's
  // path separator, not the host's — the translator is parameterised by platform.
  // On Windows that separator is `;`, which PowerShell reads as a statement
  // separator, so the joined list has to reach the shell quoted.
  const joinPathList = (list) => (platform === 'win32' ? `"${list.join(';')}"` : list.join(':'));

  // `java [vmArgs] [--module-path …] [-cp …] <mainClass|program> [args]`. The
  // extension normally resolves the classpath from the project model; when
  // launch.json doesn't spell it out we omit `-cp` and let `java` use CLASSPATH /
  // the single-file source launcher (`java Main.java`, JDK 11+).
  function buildJavaParts(cfg, { program, args, runExe }) {
    const main = cfg.mainClass ? substVars(cfg.mainClass) : '';
    if (!main && !program) return null;
    const cp = toArray(cfg.classPaths).map(substVars);
    const mp = toArray(cfg.modulePaths).map(substVars);
    const parts = [runExe || 'java', ...toArray(cfg.vmArgs).map(substVars)];
    if (mp.length) parts.push('--module-path', joinPathList(mp));
    if (cp.length) parts.push('-cp', joinPathList(cp));
    return [...parts, main || program, ...args];
  }

  // Go's `mode` decides the tool: `test` runs the package's tests, `exec` runs an
  // already-built binary, `debug`/`auto` compile-and-run the program. `replay`
  // and `core` only make sense to a debugger, so they yield nothing to run.
  function buildGoParts(cfg, { program, args }) {
    const mode = (cfg.mode || 'auto').toLowerCase();
    const buildFlags = toArray(cfg.buildFlags).map(substVars);
    if (mode === 'test') return ['go', 'test', ...buildFlags, program || './...', ...args];
    if (mode === 'exec') return program ? [program, ...args] : null;
    if (mode !== 'debug' && mode !== 'auto') return null;
    return program ? ['go', 'run', ...buildFlags, program, ...args] : null;
  }

  // CodeLLDB/rust-analyzer describe a Rust target by its cargo invocation instead
  // of a `program` — the binary doesn't exist until cargo builds it. `cargo build`
  // becomes `cargo run` (and `--no-run` drops off a test target) so the config
  // actually runs; the config's own `args` go after `--`, as cargo requires.
  function buildCargoParts(cargo, args) {
    let cargoArgs = toArray(cargo.args).map(substVars).filter((a) => a !== '--no-run');
    const sub = cargoArgs.findIndex((a) => !String(a).startsWith('-'));
    if (sub < 0) cargoArgs = ['run', ...cargoArgs];
    else if (cargoArgs[sub] === 'build') cargoArgs[sub] = 'run';
    return ['cargo', ...cargoArgs, ...(args.length ? ['--', ...args] : [])];
  }

  // .NET: `program` is the built assembly, which needs the `dotnet` host unless
  // it's a native apphost. The newer `dotnet` type points at a project instead,
  // which `dotnet run` builds and launches.
  function buildDotnetParts(cfg, { program, args }) {
    const project = cfg.projectPath ? substVars(cfg.projectPath) : '';
    if (project) return ['dotnet', 'run', '--project', project, ...(args.length ? ['--', ...args] : [])];
    if (!program) return null;
    return /\.dll$/i.test(program) ? ['dotnet', 'exec', program, ...args] : [program, ...args];
  }

  // Dart-Code uses one `dart` type for both; a Flutter-only attribute
  // (`flutterMode`/`deviceId`/`flutterPlatform`) is what marks it as a Flutter app.
  // `toolArgs` are flags for the tool, `args` are for the app — hence the `--`.
  function buildDartParts(cfg, { program, args }) {
    const toolArgs = toArray(cfg.toolArgs).map(substVars);
    const mode = cfg.flutterMode ? substVars(cfg.flutterMode) : '';
    const isFlutter = (cfg.type || '').toLowerCase() === 'flutter' || !!(mode || cfg.deviceId || cfg.flutterPlatform);
    if (!isFlutter) return program ? ['dart', 'run', ...toolArgs, program, ...args] : null;
    return [
      'flutter', 'run', ...toolArgs,
      ...(mode && mode !== 'debug' ? [`--${mode}`] : []),
      ...(cfg.deviceId ? ['-d', substVars(cfg.deviceId)] : []),
      ...(program ? ['-t', program] : []),
      ...(args.length ? ['--', ...args] : []),
    ];
  }

  // The Ruby `debug` gem's config: `command` is the executable (`ruby`, or a
  // binstub like `rails`) and `script` its first argument, so `{command: "rails",
  // script: "server"}` and `{script: "main.rb"}` both fall out of one shape.
  function buildRdbgParts(cfg, { args }) {
    const script = cfg.script ? substVars(cfg.script) : '';
    const command = cfg.command ? substVars(cfg.command) : '';
    if (!script && !command) return null;
    return [...(cfg.useBundler ? ['bundle', 'exec'] : []), command || 'ruby', script, ...args];
  }

  // Local Lua Debugger's `program` is an object, not a path: either a Lua
  // interpreter + file, or a host command (e.g. `love`) with its own args.
  function buildLuaLocalParts(cfg, { args }) {
    const p = cfg.program;
    if (!p || typeof p !== 'object') return null;
    if (p.command) return [substVars(p.command), ...toArray(p.args).map(substVars), ...args];
    if (p.file) return [p.lua ? substVars(p.lua) : 'lua', substVars(p.file), ...args];
    return null;
  }

  // Turn a launch config into a runnable command line. Covers the common node /
  // python cases, known interpreter types (TYPE_RUNTIME), plus a generic
  // runtimeExecutable/program fallback; returns null when there's nothing
  // executable to derive (e.g. a browser/attach config with no program).
  function buildLaunchCommand(cfg) {
    cfg = mergePlatform(cfg);
    // `program` is a path for every type but lua-local, where it's an object.
    const program = typeof cfg.program === 'string' && cfg.program ? substVars(cfg.program) : '';
    const args = toArray(cfg.args).map(substVars);
    const runExe = cfg.runtimeExecutable ? winExe(substVars(cfg.runtimeExecutable)) : '';
    const runArgs = toArray(cfg.runtimeArgs).map(substVars);
    const type = (cfg.type || '').toLowerCase();
    const ctxArgs = { program, args, runExe, runArgs };
    // Godot configs carry `project` + `scene` (not a `program`) and run the engine
    // binary. The Godot Tools extension keeps the binary path in a VS Code setting,
    // not in launch.json, so we can't know it — default to `godot` on PATH, letting
    // `runtimeExecutable`/`editor_path` override. A `scene` of "main"/"current"
    // (or absent) runs the project's main scene; an explicit res:// path runs that scene.
    if (type === 'godot') {
      const exe = runExe || (cfg.editor_path ? substVars(cfg.editor_path) : '') || 'godot';
      const project = cfg.project ? substVars(cfg.project) : repoPath;
      const scene = cfg.scene ? substVars(cfg.scene) : '';
      const sceneArgs = scene && scene !== 'main' && scene !== 'current' ? [scene] : [];
      const parts = [exe, '--path', project, ...sceneArgs, ...runArgs, ...args];
      return parts.filter((p) => p !== '' && p != null).map(quoteArg).join(' ');
    }
    // A browser config opens its url (or local file). Honour an explicit
    // runtimeExecutable (a specific browser binary) with its runtimeArgs; otherwise
    // hand the target to the OS opener for the default browser. No target -> nothing
    // to run.
    if (BROWSER_TYPES.has(type)) {
      const target = cfg.url ? substVars(cfg.url) : cfg.file ? substVars(cfg.file) : '';
      if (!target) return null;
      const opener = runExe ? [runExe, ...runArgs] : (OPEN_CMD[platform] || OPEN_CMD.linux);
      return [...opener, target].map(quoteArg).join(' ');
    }
    // `node-terminal` is VS Code's "just run this command line" launch type: its
    // `command` is a whole shell line, so it passes through unquoted like a shell task.
    if (type === 'node-terminal') return cfg.command ? substVars(cfg.command) : null;
    // A Rust config names a cargo target instead of a program, under any of the
    // native debug types (lldb/cppdbg) that can host it.
    if (cfg.cargo && typeof cfg.cargo === 'object') {
      return buildCargoParts(cfg.cargo, args).map(quoteArg).join(' ');
    }
    let parts;
    // An interpreter type with neither a program nor a runtimeExecutable (the
    // attach-config shape) has nothing to run — don't fall through to a bare REPL.
    if (type.includes('node')) parts = (program || runExe) ? [runExe || 'node', ...runArgs, program, ...args] : null;
    else if (type.includes('python') || type === 'debugpy') parts = buildPythonParts(cfg, ctxArgs);
    else if (type === 'java') parts = buildJavaParts(cfg, ctxArgs);
    else if (type === 'go') parts = buildGoParts(cfg, ctxArgs);
    else if (type === 'coreclr' || type === 'clr' || type === 'dotnet') parts = buildDotnetParts(cfg, ctxArgs);
    else if (type === 'dart' || type === 'flutter') parts = buildDartParts(cfg, ctxArgs);
    else if (type === 'rdbg') parts = buildRdbgParts(cfg, ctxArgs);
    else if (type === 'lua-local') parts = buildLuaLocalParts(cfg, ctxArgs);
    // The Bun extension names its interpreter `runtime`, not `runtimeExecutable`,
    // and Bun needs `run` to execute a source file.
    else if (type === 'bun') parts = program ? [runExe || (cfg.runtime ? substVars(cfg.runtime) : '') || 'bun', ...runArgs, 'run', program, ...args] : null;
    // PowerShell's `script` is a .ps1 path or, historically, a command to invoke.
    else if (type === 'powershell') {
      const script = cfg.script ? substVars(cfg.script) : program;
      parts = script ? [runExe || 'pwsh', /[\\/]|\.ps1$/i.test(script) ? '-File' : '-Command', script, ...args] : null;
    }
    // An extension-development host is just VS Code launched with the config's
    // `--extensionDevelopmentPath=…`-style args.
    else if (type === 'extensionhost') parts = (args.length || runExe) ? [runExe || 'code', ...runArgs, ...args] : null;
    // Elixir's task runner: `mix <task> <taskArgs>`.
    else if (type === 'mix_task') parts = cfg.task ? ['mix', substVars(cfg.task), ...toArray(cfg.taskArgs).map(substVars), ...args] : null;
    // The R debugger names the script `file` and only "file" mode runs standalone.
    else if (type === 'r-debugger') parts = cfg.file ? ['Rscript', substVars(cfg.file), ...args] : null;
    // Native Debug (gdb/lldb-mi) calls the binary `target` and its args `arguments`.
    else if ((type === 'gdb' || type === 'lldb-mi') && cfg.target) parts = [substVars(cfg.target), ...toArray(cfg.arguments).map(substVars), ...args];
    else if (runExe) parts = [runExe, ...runArgs, program, ...args];
    else if (TYPE_RUNTIME[type] && program) parts = [...TYPE_RUNTIME[type], ...runArgs, program, ...args];
    else if (program) parts = [program, ...args];
    else return null;
    if (!parts) return null;
    return parts.filter((p) => p !== '' && p != null).map(quoteArg).join(' ');
  }

  // Wrap a built command line in the task's custom shell (`options.shell`), when
  // one is set: `<executable> <shell args> "<line>"`. Without explicit args we
  // supply the shell's run-one-command flag (defaultShellArgs).
  function wrapShell(line, options) {
    const sh = options && options.shell;
    if (!sh || !sh.executable) return line;
    const exe = substVars(sh.executable);
    const shArgs = (sh.args && sh.args.length ? sh.args : defaultShellArgs(exe)).map(substVars);
    return [quoteArg(exe), ...shArgs.map(quoteArg), `"${line.replace(/"/g, '\\"')}"`].join(' ');
  }

  // Turn a task into a command line. Contributed task types that name their tool
  // (npm/typescript/gulp/grunt/jake) are expanded to that tool's CLI; otherwise
  // it's the `command` (verbatim for shell tasks, which may be a full line)
  // followed by its quoted args. Returns null with nothing to run.
  function buildTaskCommand(task) {
    task = mergePlatform(task);
    let line = null;
    if (task.type === 'npm') {
      const script = substVars(task.script || '');
      line = script ? ['npm', 'run', script].map(quoteArg).join(' ') : null;
    } else if (task.type === 'typescript') {
      const parts = ['npx', 'tsc'];
      if (task.tsconfig) parts.push('-p', substVars(task.tsconfig));
      if (task.option === 'watch') parts.push('--watch');
      line = parts.map(quoteArg).join(' ');
    } else if (task.type === 'gulp' || task.type === 'grunt' || task.type === 'jake') {
      const parts = ['npx', task.type];
      if (task.task) parts.push(substVars(task.task));
      line = parts.map(quoteArg).join(' ');
    } else {
      let command = task.command;
      if (command && typeof command === 'object') command = command.value;
      command = substVars(command || '');
      if (!command) return null;
      // Args may be plain strings or { value, quoting } objects; "strong"/"weak"
      // quoting means "always quote" (we can't do literal single-quoting portably,
      // so both map to our double-quote — best effort).
      const args = (task.args || []).map((a) => {
        const raw = typeof a === 'object' && a !== null ? (a.value ?? '') : a;
        const force = typeof a === 'object' && a !== null && (a.quoting === 'strong' || a.quoting === 'weak');
        const v = substVars(raw);
        return force && !/^".*"$/.test(v) ? `"${v}"` : quoteArg(v);
      });
      line = task.type === 'process'
        ? [quoteArg(command), ...args].join(' ')
        : [command, ...args].join(' '); // shell task: command stays verbatim
    }
    return line == null ? null : wrapShell(line, task.options);
  }

  // Prefix a sequence step with a directory change when it runs somewhere other than
  // the repo root, so chained steps honour their task's `options.cwd` even though
  // they share one terminal. PowerShell (the Windows default shell) has no `&&`, so
  // the chain operator differs by platform — see chainCommands.
  function stepCommand(spec) {
    if (!spec.cwd || spec.cwd === repoPath) return spec.command;
    return platform === 'win32'
      ? `Set-Location '${spec.cwd}'; ${spec.command}`
      : `cd '${spec.cwd}' && ${spec.command}`;
  }

  // Join commands so each runs only if the previous succeeded (VS Code's
  // `dependsOrder: "sequence"`). bash/zsh use `&&`; Windows PowerShell 5.1 lacks it,
  // so we gate each later step on the automatic `$?` success variable instead.
  function chainCommands(cmds) {
    if (cmds.length <= 1) return cmds[0] || '';
    if (platform !== 'win32') return cmds.join(' && ');
    let chain = cmds[cmds.length - 1];
    for (let i = cmds.length - 2; i >= 0; i--) chain = `${cmds[i]}; if ($?) { ${chain} }`;
    return chain;
  }

  // Resolve a task into terminal run specs. A plain task yields one spec. A compound
  // task (`dependsOn`, a label or array of labels) resolves each referenced task and
  // combines them per `dependsOrder`: "sequence" collapses them into ONE terminal
  // whose commands are chained so each waits for the previous to succeed; "parallel"
  // / "any" (the default) spreads them across one terminal each. A compound may also
  // carry its own `command`, which VS Code runs after its dependencies. `seen` breaks
  // reference cycles.
  function resolveTask(allTasks, task, seen = new Set()) {
    const label = task.label || task.taskName;
    if (label) {
      if (seen.has(label)) return []; // cycle guard
      seen.add(label);
    }
    const deps = task.dependsOn == null ? []
      : Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn];

    if (!deps.length) {
      const cmd = buildTaskCommand(task);
      if (!cmd) return [];
      const merged = mergePlatform(task);
      const opt = merged.options || {};
      // An npm task's `path` is its package dir (relative to the workspace);
      // an explicit options.cwd still wins.
      let cwd = opt.cwd ? substVars(opt.cwd) : repoPath;
      if (!opt.cwd && merged.type === 'npm' && merged.path) cwd = path.join(repoPath, substVars(merged.path));
      const spec = { command: cmd, cwd, env: envMap(opt.env), name: label };
      // Carried only when set, so a spec stays the minimal { command, cwd, env,
      // name } the renderer already knows. `background` keeps the task out of a
      // chain (it never exits); `presentation` decides tab reuse/focus there.
      if (merged.isBackground) spec.background = true;
      if (merged.presentation) spec.presentation = merged.presentation;
      return [spec];
    }

    const depSpecs = deps.flatMap((d) => {
      const dep = allTasks.find((x) => (x.label || x.taskName) === d);
      return dep ? resolveTask(allTasks, dep, seen) : [];
    });
    // The compound's own command (if any) runs after its deps; resolve it as a leaf.
    const ownSpecs = task.command ? resolveTask(allTasks, { ...task, dependsOn: undefined }, new Set()) : [];
    const ordered = [...depSpecs, ...ownSpecs];
    if (!ordered.length) return [];

    if (task.dependsOrder === 'sequence') {
      // One terminal, commands chained; merge the steps' envs onto it (last wins).
      // A background step (a watcher) never exits, so chaining it would stall
      // everything after it — those keep their own terminal and start alongside.
      const bg = ordered.filter((s) => s.background);
      const fg = ordered.filter((s) => !s.background);
      if (!fg.length) return bg;
      return [...bg, {
        command: chainCommands(fg.map(stepCommand)),
        cwd: repoPath,
        env: Object.assign({}, ...fg.map((s) => s.env)),
        name: label,
      }];
    }
    return ordered; // parallel / any: one terminal per resolved spec
  }

  // Fold tasks.json's *global* scope onto each task: a top-level `options` (and
  // top-level windows/osx/linux override blocks) applies to every task, with the
  // task's own values winning per property (env/cwd shallow-merged like VS Code).
  function normalizeTasks(tasksJson) {
    if (!tasksJson) return [];
    const g = mergePlatform(tasksJson);
    const gOpt = g.options;
    return (g.tasks || []).map((t) => {
      if (!gOpt || typeof gOpt !== 'object') return t;
      return { ...t, options: { ...gOpt, ...t.options, env: { ...gOpt.env, ...(t.options || {}).env } } };
    });
  }

  // VS Code's `preLaunchTask`/`postDebugTask`, resolved into the specs to run.
  // The pre-launch steps are chained in front of the launch command in ONE
  // terminal so the launch only starts once the task succeeded, and the post-debug
  // steps are appended so they run when the launched process exits. The terminal
  // sits at the repo root; every step (including the launch itself) carries its
  // own cd prefix when it runs elsewhere.
  //
  // A background task (`isBackground`: a watcher like `tsc -w`) is the exception:
  // it never exits, so chaining it would mean the launch never runs. VS Code
  // doesn't wait for it either — its background problem matcher signals "ready"
  // and the session starts alongside — so those get a terminal of their own and
  // the launch starts immediately. Returns an ARRAY: one spec per terminal.
  function prependTasks(preSpecs, spec, postSpecs = []) {
    if (!spec) return [];
    const pre = preSpecs || [];
    const background = pre.filter((s) => s.background);
    const chained = [...pre.filter((s) => !s.background), spec, ...postSpecs];
    if (chained.length === 1) return [...background, spec];
    const merged = {
      // Pre-launch steps gate the launch (`&&`), but a post-debug step is cleanup:
      // it runs whether the launch succeeded or not, hence the plain `;` join.
      command: [chainCommands(chained.slice(0, chained.length - postSpecs.length).map(stepCommand)),
        ...postSpecs.map(stepCommand)].join('; '),
      cwd: repoPath,
      env: Object.assign({}, ...chained.map((s) => s.env || {})),
      name: spec.name,
    };
    if (spec.serverReady) merged.serverReady = spec.serverReady;
    return [...background, merged];
  }

  // A run spec the renderer turns into an in-app terminal tab: the command line plus
  // the cwd/env to spawn its shell in, and the name used as the tab label.
  function launchSpec(cfg) {
    const cmd = buildLaunchCommand(cfg);
    if (!cmd) return null;
    const m = mergePlatform(cfg);
    const spec = { command: cmd, cwd: m.cwd ? substVars(m.cwd) : repoPath, env: envMap(m.env), name: m.name };
    // The renderer watches the terminal's output for this (VS Code opens the
    // browser when the program prints a matching URL) — see serverReadyMatcher.
    const ready = serverReadyMatcher(m.serverReadyAction);
    if (ready) spec.serverReady = ready;
    return spec;
  }

  // Normalize a launch config's `serverReadyAction` into what the renderer needs:
  // the pattern to look for in the terminal output and the URI to open when it
  // hits. VS Code's default pattern matches the "listening on http://…" line most
  // dev servers print; `uriFormat` places the pattern's first capture group.
  // Only the URI-opening actions are meaningful here — `startDebugging` would
  // start a second debug session, which we have no debugger for.
  function serverReadyMatcher(action) {
    if (!action || (action.action && action.action !== 'openExternally' && action.action !== 'debugWithChrome' && action.action !== 'debugWithEdge')) return null;
    return {
      pattern: action.pattern || 'listening on.* (https?://\\S+)',
      uriFormat: action.uriFormat || '%s',
    };
  }

  return { substVars, envMap, winExe, mergePlatform, buildLaunchCommand, buildTaskCommand, stepCommand, chainCommands, resolveTask, launchSpec, serverReadyMatcher, normalizeTasks, prependTasks };
}

module.exports = {
  parseJsonc, TYPE_RUNTIME, quoteArg, toArray, parseEnvFile, compoundMembers,
  listRunConfigs, npmTaskLabel, autoDetectedNpmTask, findInputIds, findCommandIds,
  defaultBuildTaskName, makeRunConfigLib,
};
