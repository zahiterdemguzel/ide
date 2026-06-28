const fs = require('fs');
const path = require('path');
const { sharedDataDir } = require('./instance');

// Claude Code runs the statusLine command as an external process, so the script
// must live on real disk — not inside the asar archive an external `node` can't
// read. Copy it (and its pure helper) out of the app bundle into the shared data
// dir once per launch and hand back the `node <path>` command for each session's
// `claude --settings` statusLine config. Electron's fs reads the asar source
// transparently; the destination is a plain folder.
const OUT_DIR = path.join(sharedDataDir, 'statusline');
const SCRIPT = path.join(OUT_DIR, 'statusline-script.js');
const FILES = ['statusline-script.js', 'statusline-lib.js'];

let staged = null; // null = not tried yet, true/false = result, cached per launch
function stageScript() {
  if (staged !== null) return staged;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of FILES) fs.copyFileSync(path.join(__dirname, f), path.join(OUT_DIR, f));
    staged = true;
  } catch {
    staged = false;
  }
  return staged;
}

// User toggle (Settings → General → token meter). The renderer pushes the saved
// value on startup and on change; default on. When off, no statusLine is injected
// into the next-spawned session's settings (live sessions keep theirs).
let enabled = true;
function setEnabled(on) { enabled = !!on; }

// The `statusLine.command` string, or null when disabled or the script can't be
// staged. `node` is assumed on PATH (this is a developer's machine running a Node
// CLI); if it's absent Claude simply renders no status line and the session is
// otherwise unaffected.
function statusLineCommand() {
  if (!enabled) return null;
  return stageScript() ? `node "${SCRIPT}"` : null;
}

module.exports = { statusLineCommand, setEnabled };
