// Builds the GPU speech engine — whisper.cpp's `whisper-server` with the Metal
// backend — from a pinned source tag into vendor/stt/bin/, where electron-builder
// picks it up with the rest of vendor/stt (extraResources). macOS only.
//
// The build flags make one self-contained binary: static ggml/whisper libraries and
// the Metal shader library embedded, so it links only system frameworks and can be
// shipped and code-signed as a single file. GGML_NATIVE=OFF plus a universal
// (arm64 + x86_64) build keeps it portable to every Mac the app's dmg targets,
// instead of tuned to the build host's CPU.
//
// Needs cmake and the Xcode command-line tools. Called by fetch-stt-model.mjs, which
// treats a failure as non-fatal (the CPU engine is used instead); run directly with
// `node scripts/build-whisper-server.mjs` to retry.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import stt from '../src/main/stt-lib.js';

const { GPU_ENGINE, gpuEngineFiles, DEFAULT_MODEL_ID, statSize } = stt;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sttRoot = path.join(repoRoot, 'vendor', 'stt');
const log = (msg) => process.stderr.write(`[stt] ${msg}\n`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  if (r.error) throw new Error(`could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-5).join('\n');
    throw new Error(`${cmd} ${args[0]} failed: ${tail || `exit ${r.status}`}`);
  }
}

export async function buildWhisperServer({ force = false } = {}) {
  const { binary } = gpuEngineFiles(sttRoot, DEFAULT_MODEL_ID, path.join);
  if (!force && statSize(binary)) { log('whisper-server already built — skipping'); return binary; }
  if (process.platform !== 'darwin') throw new Error('the GPU speech engine is only built on macOS');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-cpp-'));
  try {
    log(`downloading whisper.cpp ${GPU_ENGINE.tag} source`);
    const res = await fetch(GPU_ENGINE.sourceUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${GPU_ENGINE.sourceUrl}`);
    const archive = path.join(work, 'source.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    run('tar', ['-xzf', archive, '-C', work]);
    const src = fs.readdirSync(work).map((n) => path.join(work, n)).find((p) => fs.statSync(p).isDirectory());
    if (!src) throw new Error('the source archive had no folder');

    log('building whisper-server with Metal (takes a minute)');
    const build = path.join(src, 'build');
    run('cmake', ['-S', src, '-B', build,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF',
      '-DGGML_METAL=ON',
      '-DGGML_METAL_EMBED_LIBRARY=ON',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_SERVER=ON',
      // Universal: the mac build targets both architectures, and without an x64
      // slice an Intel build would have no GPU engine (and no CPU model, which the
      // fetch skips once this succeeds).
      '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
      '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0']);
    run('cmake', ['--build', build, '--config', 'Release', '-j', String(os.cpus().length || 4), '--target', GPU_ENGINE.binary]);

    const built = path.join(build, 'bin', GPU_ENGINE.binary);
    if (!statSize(built)) throw new Error(`the build produced no ${GPU_ENGINE.binary}`);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    // Copy to a temp name first so an interrupted copy never looks like a built binary.
    fs.copyFileSync(built, `${binary}.part`);
    fs.chmodSync(`${binary}.part`, 0o755);
    fs.renameSync(`${binary}.part`, binary);
    log('whisper-server ready');
    return binary;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  buildWhisperServer({ force: process.argv.includes('--force') }).catch((err) => {
    log(`could not build whisper-server: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
