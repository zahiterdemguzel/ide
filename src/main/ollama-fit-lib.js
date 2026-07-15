// Pure "will this model run on this machine?" logic. Turns a model's RAM/VRAM
// needs (from the catalog in ollama-models-lib.js) plus the detected system spec
// into a fit level the UI draws a warning from — a red sign for `fail`, a softer
// one for `tight`. Electron-free + unit-tested (test/ollama-fit-lib.test.js);
// src/main/ollama.js does the actual hardware probe (detectSystem) and feeds the
// numbers here.

// Needing more than this fraction of a resource is "tight" — it may run but swap
// or crawl. Below it is "ok".
const HEADROOM = 0.85;

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// model: { minRam?, minVram? } (GB). sys: { ramGB?, vramGB?, unified? }.
// -> { level: 'ok' | 'tight' | 'fail' | 'unknown', reason }.
function modelFit(model, sys) {
  const minRam = num(model && model.minRam);
  const minVram = num(model && model.minVram);
  // A free-typed model has no known requirement — we can't judge it.
  if (minRam == null && minVram == null) return { level: 'unknown', reason: 'no-requirement' };

  const ramGB = num(sys && sys.ramGB);
  let vramGB = num(sys && sys.vramGB);
  // Apple Silicon / iGPU: memory is unified, so treat system RAM as the VRAM pool.
  if (vramGB == null && ramGB != null && sys && sys.unified) vramGB = ramGB;

  // Nothing detected — can't be sure it fits.
  if (ramGB == null && vramGB == null) return { level: 'unknown', reason: 'no-system' };

  // Hard fail: over budget on a *known* resource.
  if (minRam != null && ramGB != null && minRam > ramGB) return { level: 'fail', reason: 'ram' };
  if (minVram != null && vramGB != null && minVram > vramGB) return { level: 'fail', reason: 'vram' };

  // Tight: within the headroom margin on a known resource.
  if (minRam != null && ramGB != null && minRam > ramGB * HEADROOM) return { level: 'tight', reason: 'ram' };
  if (minVram != null && vramGB != null && minVram > vramGB * HEADROOM) return { level: 'tight', reason: 'vram' };

  return { level: 'ok', reason: '' };
}

// "RAM 8 GB · VRAM 6 GB" — the requirement line shown next to a catalog model.
function formatReq(model) {
  const parts = [];
  const minRam = num(model && model.minRam);
  const minVram = num(model && model.minVram);
  if (minRam != null) parts.push(`RAM ${minRam} GB`);
  if (minVram != null) parts.push(`VRAM ${minVram} GB`);
  return parts.join(' · ');
}

module.exports = { HEADROOM, modelFit, formatReq };
