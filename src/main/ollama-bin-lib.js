// Pure path/port helpers for the embedded Ollama engine. Electron-free +
// unit-tested (test/ollama-bin-lib.test.js); src/main/ollama.js resolves the real
// base dir (vendor/ in dev, process.resourcesPath when packaged) and does the
// actual socket bind, ollama-proxy.js binds the proxy.

// Where the bundled standalone binary sits under the ollama base dir, per OS/arch.
// Windows ships ollama.exe; macOS/Linux ship a bare `ollama`. The subdir matches
// what scripts/fetch-ollama.mjs writes and package.json's extraResources ships.
function binRelPath(platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return { subdir: `win32-${a}`, exe: 'ollama.exe' };
  if (platform === 'darwin') return { subdir: `darwin-${a}`, exe: 'ollama' };
  return { subdir: `linux-${a}`, exe: 'ollama' };
}

// Pick a concrete port for `ollama serve`, avoiding ports we already know are
// taken. 0/invalid means "let the OS pick an ephemeral port". The actual
// in-use probe stays in the shell; this just steps past known-taken ports.
function pickPort(preferred, taken) {
  const used = new Set(taken || []);
  let p = Math.trunc(Number(preferred));
  if (!Number.isInteger(p) || p <= 0) return 0;
  while (used.has(p)) p += 1;
  return p;
}

module.exports = { binRelPath, pickPort };
