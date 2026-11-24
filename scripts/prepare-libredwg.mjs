// Prepare the two GNU LibreDWG tools used by the desktop package. The official
// release's corresponding source and license travel alongside the executables.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

const version = '0.14';
const target = process.argv[2];
const host = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
if (target !== 'win' && target !== host) throw new Error('Build the LibreDWG tools on the target platform.');
const root = fileURLToPath(new URL('../vendor/libredwg/', import.meta.url));
const arch = target === 'win' ? 'x64' : process.arch;
const destination = path.join(root, target, arch, version);
const extension = target === 'win' ? '.exe' : '';
const programs = ['dwg2dxf', 'dxf2dwg'];
const platformFiles = programs.map(name => name + extension);
if (target === 'win') platformFiles.push('libredwg-0.dll');

async function fetchAsset(filename, sha256, dir) {
  const url = 'https://github.com/LibreDWG/libredwg/releases/download/' + version + '/' + filename;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not fetch ' + filename + ' (HTTP ' + response.status + ')');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(filename + ' checksum mismatch');
  const file = path.join(dir, filename);
  await fs.writeFile(file, bytes);
  return file;
}

// Exercise the same tools from the bundle directory, including DLL resolution
// on Windows, before a native release build is allowed to package them.
async function verifyBundle(bundle, work) {
  const fixture = fileURLToPath(new URL('../resources/test/cad-line-circle.dwg', import.meta.url));
  const firstDxf = path.join(work, 'check.dxf');
  const savedDwg = path.join(work, 'check.dwg');
  const reopened = path.join(work, 'reopened.dxf');
  const read = path.join(bundle, 'dwg2dxf' + extension);
  const write = path.join(bundle, 'dxf2dwg' + extension);
  execFileSync(read, ['-o', firstDxf, fixture], { cwd: work });
  execFileSync(write, ['--as', 'r2000', '-o', savedDwg, firstDxf], { cwd: work });
  execFileSync(read, ['-o', reopened, savedDwg], { cwd: work });
  const text = await fs.readFile(reopened, 'utf8');
  if (!/^LINE\r?$/m.test(text) || !/^CIRCLE\r?$/m.test(text)) throw new Error('Packaged LibreDWG lost fixture geometry.');
}

async function prepare() {
  try {
    await Promise.all([...platformFiles, 'COPYING', 'libredwg-0.14.tar.xz'].map(name => fs.access(path.join(destination, name))));
    return;
  } catch { /* First package build for this platform. */ }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const work = await fs.mkdtemp(path.join(path.dirname(destination), '.build-'));
  try {
    const output = path.join(work, 'bundle');
    await fs.mkdir(output);
    const archive = await fetchAsset('libredwg-0.14.tar.xz', '62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275', output);
    execFileSync('tar', ['-xf', archive, '-C', work]);
    const source = path.join(work, 'libredwg-0.14');
    await fs.copyFile(path.join(source, 'COPYING'), path.join(output, 'COPYING'));
    let binaries = work;
    if (target === 'win') {
      const zip = await fetchAsset('libredwg-0.14-win64.zip', '1ad7e15344d20b3426c3435b078d82fb84b35062815946b2cca9c5fc9810fea8', work);
      if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', zip, '-C', work, ...platformFiles]);
      else execFileSync('unzip', ['-q', zip, ...platformFiles, '-d', work]);
    } else {
      const options = { cwd: source, stdio: 'inherit', env: { ...process.env, CFLAGS: '-Os' } };
      execFileSync('./configure', ['--disable-shared', '--enable-static', '--disable-docs', '--disable-json',
        '--disable-bindings', '--disable-python', '--disable-werror'], options);
      const jobs = '-j' + Math.min(os.availableParallelism(), 6);
      execFileSync('make', ['-C', 'src', jobs], options);
      execFileSync('make', ['-C', 'programs', jobs, ...programs], options);
      binaries = path.join(source, 'programs');
    }
    for (const name of platformFiles) await fs.copyFile(path.join(binaries, name), path.join(output, name));
    if (target !== 'win') for (const name of programs) await fs.chmod(path.join(output, name), 0o755);
    if (target === host) await verifyBundle(output, work);
    await fs.rename(output, destination);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

await prepare();
