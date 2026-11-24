const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanEnv } = require('./proc-env');
const { adoptLoginShellPath } = require('./shell-path');

const run = promisify(execFile);

// LibreDWG takes filenames, so overlapping reads and saves get separate work
// directories. Conversion and malformed inputs stay outside Electron's process.
async function converterPath(command) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = platform === 'win' ? 'x64' : process.arch;
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'libredwg');
  const local = platform && path.join(__dirname, '../../vendor/libredwg', platform, arch, '0.14');
  for (const dir of [bundled, local].filter(Boolean)) {
    const executable = path.join(dir, command + extension);
    try { await fs.access(executable); return executable; } catch { /* Try the next install. */ }
  }
  await adoptLoginShellPath();
  return command;
}

async function convert(bytes, from, to) {
  const command = from + '2' + to;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-drawing-'));
  try {
    const input = path.join(temp, 'input.' + from);
    const output = path.join(temp, 'output.' + to);
    await fs.writeFile(input, bytes);
    const executable = await converterPath(command);
    const version = to === 'dwg' ? ['--as', 'r2000'] : [];
    try {
      await run(executable, [...version, '-o', output, input], {
        cwd: temp, env: cleanEnv(), windowsHide: true, timeout: 120000,
      });
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error('Install GNU LibreDWG and add dwg2dxf and dxf2dwg to PATH to edit DWG drawings.');
      }
      const detail = String(e.stderr || '').trim() || (e.killed ? 'Conversion timed out' : 'Converter exited unexpectedly');
      throw new Error(command + ' failed. ' + detail);
    }
    return await fs.readFile(output);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = {
  converterPath,
  dwgToDxf: (bytes) => convert(bytes, 'dwg', 'dxf'),
  dxfToDwg: (bytes) => convert(bytes, 'dxf', 'dwg'),
};
