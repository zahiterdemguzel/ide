// The official build includes the complete CAD drawing editor and its notices.
// Release source and build recipe: github.com/storytold/cadcraft/tree/v0.20.1/packaging/web
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';

const release = 'cadcraft-web-0.20.1';
const digest = '300e870c50b66d371055915ba95e3ddbfd4c45431466d5214743b5dcab95a0e1';
const root = fileURLToPath(new URL('../vendor/cadcraft/', import.meta.url));
const dest = path.join(root, release);
const engine = 'cadcraft-web-a91fdcd993cc5580_bg.wasm';
async function prepare() {
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.access(path.join(dest, engine));
  } catch {
    const temp = await fs.mkdtemp(path.join(root, '.fetch-'));
    try {
      const url = 'https://github.com/storytold/cadcraft/releases/download/v0.20.1/' + release + '.zip';
      const response = await fetch(url);
      if (!response.ok) throw new Error('CADCraft download failed with HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('CADCraft release checksum mismatch');
      const zip = path.join(temp, 'cadcraft.zip');
      await fs.writeFile(zip, bytes);
      if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', zip, '-C', temp]);
      else execFileSync('unzip', ['-q', zip, '-d', temp]);
      await fs.rename(path.join(temp, release), dest);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

try {
  await prepare();
} catch (error) {
  if (!process.argv.includes('--optional')) throw error;
  console.warn('DWG editor unavailable. Retry npm run fetch:cad. ' + error.message);
}
