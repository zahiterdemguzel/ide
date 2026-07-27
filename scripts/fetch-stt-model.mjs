// Fetches the bundled speech-to-text models at install time (npm postinstall) into
// the gitignored vendor/stt/, which electron-builder then ships as extraResources.
// The weights are ~770 MB — far too large to commit — so they're downloaded once
// per machine and skipped on every later install.
//
// Deliberately non-fatal: a network failure prints a warning and exits 0 rather
// than breaking `npm install` for the whole IDE over one optional feature. Voice
// input then reports itself unavailable in Settings, and `npm run fetch:stt`
// retries. Set SKIP_STT_MODEL=1 to skip entirely (CI jobs that only lint/test).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import stt from '../src/main/stt-lib.js';

// statSize comes from the shared lib too, so the downloader and the engine can't
// drift on what counts as an installed model.
const { MODELS, VAD_ASSET, assetUrl, modelFiles, modelReady, statSize } = stt;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repoRoot, 'vendor', 'stt');
const cacheDir = path.join(root, '.cache');

const log = (msg) => process.stderr.write(`[stt] ${msg}\n`);

// Resumable download: a partial `.part` from an interrupted run is continued with
// a Range request instead of restarting an 800 MB transfer from zero.
async function download(url, dest, expectedBytes) {
  const part = `${dest}.part`;
  const have = statSize(part) || 0;
  if (expectedBytes && have === expectedBytes) {
    fs.renameSync(part, dest);
    return;
  }
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
  // A server that ignored our Range restarts the file, so the old bytes must go.
  const resuming = res.status === 206 && have > 0;
  const out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });

  const total = expectedBytes || Number(res.headers.get('content-length')) || 0;
  let seen = resuming ? have : 0;
  let lastPct = -1;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (chunks) {
      for await (const c of chunks) {
        seen += c.length;
        const pct = total ? Math.floor((seen / total) * 100) : 0;
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; log(`${path.basename(dest)} ${pct}%`); }
        yield c;
      }
    },
    out,
  );

  const got = statSize(part);
  if (expectedBytes && got !== expectedBytes) {
    fs.rmSync(part, { force: true });
    throw new Error(`${path.basename(dest)}: expected ${expectedBytes} bytes, got ${got}`);
  }
  // Rename only after the size checks out, so an interrupted run can never leave
  // a truncated file that later looks like a valid download.
  fs.renameSync(part, dest);
}

// bzip2 is not in Node's zlib, so extraction goes through the platform `tar`
// (bsdtar on Windows 10+ and macOS both auto-detect the compression).
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const r = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) throw new Error(`could not run tar: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar failed: ${String(r.stderr || '').trim() || `exit ${r.status}`}`);
}

// The archives name their weights after the model (`turbo-encoder.int8.onnx`,
// `base.en-encoder.int8.onnx`, …). Normalizing to fixed names here means the
// engine needs no per-model filename knowledge, and dropping the fp32 weights the
// archive also carries keeps the installer at a third of the extracted size.
function collect(fromDir, files) {
  const found = { encoder: null, decoder: null, tokens: null };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (/-encoder\.int8\.onnx$/.test(entry.name)) found.encoder = p;
      else if (/-decoder\.int8\.onnx$/.test(entry.name)) found.decoder = p;
      else if (/-tokens\.txt$/.test(entry.name)) found.tokens = p;
    }
  };
  walk(fromDir);
  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`archive has no ${missing.join(', ')}`);

  fs.mkdirSync(files.dir, { recursive: true });
  fs.renameSync(found.encoder, files.encoder);
  fs.renameSync(found.decoder, files.decoder);
  fs.renameSync(found.tokens, files.tokens);
}

async function fetchModel(model) {
  const files = modelFiles(root, model.id, path.join);
  if (modelReady(root, model.id, statSize, path.join)) {
    log(`${model.id} already present — skipping`);
    return;
  }
  log(`fetching ${model.label} (${(model.bytes / 1e6).toFixed(0)} MB compressed)`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, model.archive);
  if (statSize(archive) !== model.bytes) await download(assetUrl(model.archive), archive, model.bytes);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `stt-${model.id}-`));
  try {
    extract(archive, tmp);
    collect(tmp, files);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.rmSync(archive, { force: true });
  log(`${model.id} ready`);
}

async function fetchVad() {
  const dest = stt.vadPath(root, path.join);
  if (statSize(dest) === VAD_ASSET.bytes) { log('silero VAD already present — skipping'); return; }
  fs.mkdirSync(root, { recursive: true });
  await download(assetUrl(VAD_ASSET.name), dest, VAD_ASSET.bytes);
  log('silero VAD ready');
}

async function main() {
  if (process.env.SKIP_STT_MODEL === '1') { log('SKIP_STT_MODEL=1 — skipping voice-input models'); return; }
  fs.mkdirSync(root, { recursive: true });
  await fetchVad();
  for (const model of MODELS) await fetchModel(model);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  log('voice input ready');
}

main().catch((err) => {
  // Non-fatal by design — see the header comment.
  log(`could not fetch the voice-input models: ${err && err.message ? err.message : err}`);
  log('voice input will stay disabled. Retry with: npm run fetch:stt');
});
