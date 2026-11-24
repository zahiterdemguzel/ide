const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { adoptLoginShellPath } = require('./shell-path');
const { findExecutable, searchDirs } = require('./lsp-lib');
const { isCadFile } = require('./cad-files');
const { cleanEnv } = require('./proc-env');
const { converterPath } = require('./cad-dwg-convert');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function installedDirs(root) {
  try { return fs.readdirSync(root); }
  catch { return []; }
}

function resolveFreeCAD({ platform, env, home, executable = isExecutable, list = installedDirs }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.FREECAD_EXECUTABLE) {
    if (paths.isAbsolute(env.FREECAD_EXECUTABLE) && executable(env.FREECAD_EXECUTABLE)) {
      return env.FREECAD_EXECUTABLE;
    }
    throw new Error('FREECAD_EXECUTABLE must be the absolute path to the FreeCAD executable.');
  }

  const extra = [];
  if (platform === 'darwin') {
    extra.push('/Applications/FreeCAD.app/Contents/MacOS',
      paths.join(home, 'Applications/FreeCAD.app/Contents/MacOS'));
  } else if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'],
      env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Programs')];
    for (const root of new Set(roots.filter(Boolean))) {
      const installs = list(root).filter(name => /^FreeCAD(?:\s|$)/i.test(name));
      installs.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      extra.push(...installs.map(name => paths.join(root, name, 'bin')));
    }
  } else {
    extra.push('/snap/bin', '/var/lib/flatpak/exports/bin',
      paths.join(home, '.local/share/flatpak/exports/bin'));
  }

  const dirs = searchDirs({ platform, envPath: env.PATH || env.Path, extra }).filter(dir => paths.isAbsolute(dir));
  const names = platform === 'win32' ? ['FreeCAD.exe'] : ['FreeCAD', 'freecad', 'org.freecad.FreeCAD'];
  for (const name of names) {
    const found = findExecutable(name, dirs, { platform, isFile: executable, pathext: '.exe' });
    if (found) return found;
  }
  throw new Error('Install FreeCAD or set FREECAD_EXECUTABLE to its full executable path, then restart the IDE.');
}

async function openInFreeCAD(file) {
  if (!path.isAbsolute(file) || !isCadFile(file)) {
    throw new Error('Select a STEP, DWG or FreeCAD document.');
  }
  await adoptLoginShellPath();
  const command = resolveFreeCAD({ platform: process.platform, env: process.env, home: os.homedir() });
  const env = cleanEnv();
  const args = [file];
  if (path.extname(file).toLowerCase() === '.dwg') {
    const macro = path.join('cad', 'freecad-dwg.FCMacro');
    const bundled = process.resourcesPath && path.join(process.resourcesPath, macro);
    args.unshift(bundled && fs.existsSync(bundled) ? bundled : path.join(__dirname, '../../resources', macro));
    const converter = await converterPath('dwg2dxf');
    if (path.isAbsolute(converter)) {
      const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
      env[key] = [path.dirname(converter), env[key]].filter(Boolean).join(path.delimiter);
    }
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { openInFreeCAD, resolveFreeCAD };
