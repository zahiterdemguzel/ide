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
// `program` but no explicit `runtimeExecutable` still resolves (e.g. a `go` config
// -> `go run <program>`). node/python are handled inline in buildLaunchCommand.
const TYPE_RUNTIME = {
  go: ['go', 'run'],
  php: ['php'],
  ruby: ['ruby'],
  rdebug: ['ruby'],
  perl: ['perl'],
  lua: ['lua'],
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

const quoteArg = (a) => { a = String(a); return /\s/.test(a) ? `"${a}"` : a; };

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

// Scan resolved run specs for unresolved ${input:id} placeholders — the ids the
// caller must collect values for (VS Code's `inputs`) before the run can start.
function findInputIds(specs) {
  const ids = new Set();
  const scan = (s) => {
    if (typeof s !== 'string') return;
    for (const m of s.matchAll(/\$\{input:([^}]+)\}/g)) ids.add(m[1]);
  };
  for (const spec of specs || []) {
    scan(spec.command); scan(spec.cwd);
    for (const v of Object.values(spec.env || {})) scan(v);
  }
  return [...ids];
}

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
      }
      if (key.startsWith('env:')) return process.env[key.slice(4)] || '';
      if (key.startsWith('config:')) {
        const v = (ctx.settings || {})[key.slice(7)]; // settings.json keys are literal dotted strings
        return v == null ? '' : String(v);
      }
      if (key.startsWith('input:')) {
        const v = (ctx.inputs || {})[key.slice(6)];
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

  // Turn a launch config into a runnable command line. Covers the common node /
  // python cases, known interpreter types (TYPE_RUNTIME), plus a generic
  // runtimeExecutable/program fallback; returns null when there's nothing
  // executable to derive (e.g. a browser/attach config with no program).
  function buildLaunchCommand(cfg) {
    cfg = mergePlatform(cfg);
    const program = cfg.program ? substVars(cfg.program) : '';
    const args = (cfg.args || []).map(substVars);
    const runExe = cfg.runtimeExecutable ? winExe(substVars(cfg.runtimeExecutable)) : '';
    const runArgs = (cfg.runtimeArgs || []).map(substVars);
    const type = (cfg.type || '').toLowerCase();
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
    let parts;
    // An interpreter type with neither a program nor a runtimeExecutable (the
    // attach-config shape) has nothing to run — don't fall through to a bare REPL.
    if (type.includes('node')) parts = (program || runExe) ? [runExe || 'node', ...runArgs, program, ...args] : null;
    else if (type.includes('python') || type === 'debugpy') parts = (program || runExe) ? [runExe || 'python', ...runArgs, program, ...args] : null;
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
      return [{ command: cmd, cwd, env: envMap(opt.env), name: label }];
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
      return [{
        command: chainCommands(ordered.map(stepCommand)),
        cwd: repoPath,
        env: Object.assign({}, ...ordered.map((s) => s.env)),
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

  // VS Code's `preLaunchTask`: chain the task's resolved steps in front of the
  // launch command in ONE terminal, so the launch only starts once the task
  // succeeded. The terminal sits at the repo root; every step (including the
  // launch itself) carries its own cd prefix when it runs elsewhere.
  function prependTasks(taskSpecs, spec) {
    if (!spec || !taskSpecs || !taskSpecs.length) return spec;
    const all = [...taskSpecs, spec];
    return {
      command: chainCommands(all.map(stepCommand)),
      cwd: repoPath,
      env: Object.assign({}, ...all.map((s) => s.env || {})),
      name: spec.name,
    };
  }

  // A run spec the renderer turns into an in-app terminal tab: the command line plus
  // the cwd/env to spawn its shell in, and the name used as the tab label.
  function launchSpec(cfg) {
    const cmd = buildLaunchCommand(cfg);
    if (!cmd) return null;
    const m = mergePlatform(cfg);
    return { command: cmd, cwd: m.cwd ? substVars(m.cwd) : repoPath, env: envMap(m.env), name: m.name };
  }

  return { substVars, envMap, winExe, mergePlatform, buildLaunchCommand, buildTaskCommand, stepCommand, chainCommands, resolveTask, launchSpec, normalizeTasks, prependTasks };
}

module.exports = { parseJsonc, TYPE_RUNTIME, quoteArg, parseEnvFile, compoundMembers, findInputIds, defaultBuildTaskName, makeRunConfigLib };
