// Build-time helper: download the standalone Ollama engine binary for the *build*
// machine's platform/arch into vendor/ollama/<subdir>/, where electron-builder's
// extraResources ships it into the packaged app (and where src/main/ollama.js
// resolves it in a dev run). Run automatically by `npm run build*`; also runnable
// on its own (`npm run fetch:ollama`) to prime a dev machine.
//
// The layout mirrors src/main/ollama-bin-lib.js's binRelPath(): the extracted
// binary (and any sibling runner libs) live directly under the subdir, so serve
// finds its runners next to the exe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://github.com/ollama/ollama/releases/latest/download';

// (platform, arch) -> { subdir, asset }. subdir must match ollama-bin-lib.js.
function target(platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return { subdir: `win32-${a}`, asset: `ollama-windows-${a === 'arm64' ? 'arm64' : 'amd64'}.zip` };
  if (platform === 'darwin') return { subdir: `darwin-${a}`, asset: 'ollama-darwin.tgz' };
  return { subdir: `linux-${a}`, asset: `ollama-linux-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz` };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'claude-session-editor-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GET ${url} -> ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      return undefined;
    });
    req.on('error', reject);
  });
}

// Extract a downloaded archive. A .tgz uses `tar` (present on macOS/Linux — the
// only OSes that produce the .tgz asset). A Windows .zip uses PowerShell's
// Expand-Archive: it's always available and, unlike a shell-resolved `tar` (GNU
// tar in Git Bash can't read a .zip and misparses a `C:\` path as a remote host),
// it's deterministic regardless of which shell invoked npm.
function extract(archive, destDir) {
  if (archive.endsWith('.tgz') || archive.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', path.basename(archive), '-C', destDir], { cwd: path.dirname(archive), stdio: 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force`], { stdio: 'inherit' });
    return;
  }
  // A .zip on macOS/Linux (unlikely for the current asset set) — bsdtar handles it.
  execFileSync('tar', ['-xf', path.basename(archive), '-C', destDir], { cwd: path.dirname(archive), stdio: 'inherit' });
}

async function main() {
  const { subdir, asset } = target(process.platform, process.arch);
  const destDir = path.join(ROOT, 'vendor', 'ollama', subdir);
  fs.mkdirSync(destDir, { recursive: true });

  // Skip if already fetched (a bare `ollama`/`ollama.exe` present).
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  if (fs.existsSync(path.join(destDir, exe))) {
    console.log(`[fetch-ollama] ${subdir}/${exe} already present — skipping`);
    return;
  }

  const tmp = path.join(os.tmpdir(), asset);
  console.log(`[fetch-ollama] downloading ${asset} …`);
  await download(`${BASE}/${asset}`, tmp);
  console.log(`[fetch-ollama] extracting into vendor/ollama/${subdir} …`);
  extract(tmp, destDir);
  try { fs.unlinkSync(tmp); } catch { /* leave the temp file */ }
  if (process.platform !== 'win32') { try { fs.chmodSync(path.join(destDir, exe), 0o755); } catch { /* best effort */ } }
  console.log('[fetch-ollama] done');
}

// `--optional` (used from postinstall): a failure — offline, CI with no network —
// warns but doesn't abort `npm install`. The user can retry with `npm run
// fetch:ollama`, and a packaged build (which needs the binary) runs without the
// flag, so it still fails hard there.
const optional = process.argv.includes('--optional');
main().catch((err) => {
  console.error('[fetch-ollama] failed:', err.message);
  if (optional) {
    console.error('[fetch-ollama] skipping (run "npm run fetch:ollama" later to enable custom models)');
    process.exit(0);
  }
  process.exit(1);
});
