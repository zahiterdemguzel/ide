#!/usr/bin/env node
'use strict';

// macOS SIGKILLs every Electron helper (GPU/renderer/network all "killed 9")
// when the Electron.app bundle's code signature is invalid — which an npm
// install/rebuild, a file-sync tool, or antivirus can do by touching the
// bundle. Re-signing ad-hoc restores it. Runs as postinstall so a fresh
// install never lands a broken signature. No-op off macOS (Windows is the
// build target and signs its own way).

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

if (process.platform !== 'darwin') process.exit(0);

const appPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
if (!fs.existsSync(appPath)) process.exit(0);

function signatureValid() {
  try {
    execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (signatureValid()) process.exit(0);

try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('Re-signed Electron.app (its code signature was invalid; macOS would have SIGKILLed it).');
} catch (err) {
  console.warn('Could not re-sign Electron.app:', err.message);
  console.warn('If the app dies at startup with "killed 9", run: codesign --force --deep --sign - ' + appPath);
}
