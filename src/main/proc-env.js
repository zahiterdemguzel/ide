// Scrub the host app's debugger/runtime pollution out of an inherited environment
// before handing it to a child process. Both the `claude` session PTY and the
// console PTYs (incl. the setup gate's install/auth terminal) run the `claude` CLI,
// which is a Node process: when this app is launched from the VS Code debugger,
// `process.env` carries `ELECTRON_RUN_AS_NODE`, `VSCODE_INSPECTOR_OPTIONS`, and a
// `NODE_OPTIONS=--require <js-debug bootloader> --inspect…` that make any spawned Node
// child boot as a debug-attached target and fail — which is why the install could die
// in our terminal yet succeed in a clean Terminal. See .claude/memory/platform-notes.md.
//
// Pure (takes/returns an env object), so it's unit-tested (test/proc-env.test.js).
function cleanEnv(base = process.env) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  delete env.VSCODE_PID;
  if (env.NODE_OPTIONS) {
    // Strip the js-debug bootloader require and *every* --inspect* variant (the broad
    // pattern matters: js-debug uses --inspect-publish-uid=http, and a narrow regex
    // would leave "-publish-uid=http" orphaned, which Node then rejects).
    const cleaned = env.NODE_OPTIONS
      .replace(/--require[= ]\S*(vscode|js-debug|bootloader)\S*/gi, '')
      .replace(/--inspect[\w-]*(=\S*)?/gi, '')
      .trim();
    if (cleaned) env.NODE_OPTIONS = cleaned; else delete env.NODE_OPTIONS;
  }
  return env;
}

module.exports = { cleanEnv };
