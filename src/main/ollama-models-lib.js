// Pure, Electron-free helpers for the Ollama "custom models" feature: the id
// namespacing that keeps Ollama models from colliding with Claude aliases, the
// merge that folds installed Ollama models into the Claude list the model UIs
// draw, the catalog of installable models (with their RAM/VRAM needs), and the
// pull-progress line parser. Kept pure so it's unit-tested
// (test/ollama-models-lib.test.js); src/main/ollama.js is the IPC/HTTP shell.

const OLLAMA_PREFIX = 'ollama:';

function isOllamaId(id) {
  return typeof id === 'string' && id.startsWith(OLLAMA_PREFIX);
}

// 'llama3.1:8b' -> 'ollama:llama3.1:8b'
function toOllamaId(name) {
  return OLLAMA_PREFIX + String(name);
}

// 'ollama:llama3.1:8b' -> 'llama3.1:8b' (the bare name Ollama + the CLI need)
function ollamaName(id) {
  return isOllamaId(id) ? id.slice(OLLAMA_PREFIX.length) : id;
}

// Fold the installed Ollama models into the static Claude model list the
// dropdowns/caret menu/badge draw from. Claude entries first (unchanged), then
// the Ollama models sorted by name; ids are deduped so a name can't appear twice.
// installedOllama entries may be plain strings or objects with a `name`.
function mergeModels(claudeModels = [], installedOllama = []) {
  const claude = (claudeModels || []).map((m) => ({ id: m.id, name: m.name, ollama: false }));
  const seen = new Set(claude.map((m) => m.id));
  const ollama = [];
  for (const m of installedOllama || []) {
    const name = typeof m === 'string' ? m : m && m.name;
    if (!name) continue;
    const id = toOllamaId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    ollama.push({ id, name, ollama: true });
  }
  ollama.sort((a, b) => a.name.localeCompare(b.name));
  return [...claude, ...ollama];
}

// One line of Ollama's /api/pull stream (a JSON string or already-parsed object)
// -> { phase, pct, done, error }. pct is null when the line carries no byte
// totals (e.g. "pulling manifest"); a divide-by-zero total is treated as null.
function parsePullProgress(line) {
  let o = line;
  if (typeof line === 'string') {
    const s = line.trim();
    if (!s) return null;
    try { o = JSON.parse(s); } catch { return null; }
  }
  if (!o || typeof o !== 'object') return null;
  if (o.error) return { phase: 'error', pct: null, done: true, error: String(o.error) };
  const status = typeof o.status === 'string' ? o.status : '';
  const done = status === 'success';
  let pct = null;
  if (typeof o.total === 'number' && o.total > 0 && typeof o.completed === 'number') {
    pct = Math.max(0, Math.min(100, Math.round((o.completed / o.total) * 100)));
  } else if (done) {
    pct = 100;
  }
  return { phase: done ? 'success' : (status || 'pulling'), pct, done, error: null };
}

// A small curated set of tool-capable models the search box shows by default —
// Ollama has no official search API, so this doubles as the browse list (users
// can still type an exact `name:tag` to pull anything). minRam/minVram are GB,
// approximated from parameter count × Q4 quantization + runtime overhead, and
// feed the fit check (src/main/ollama-fit-lib.js).
const CATALOG = [
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', description: 'Small, fast general model for low-end machines.', minRam: 4, minVram: 3 },
  { name: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', description: 'Tiny coding model.', minRam: 4, minVram: 2 },
  { name: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', description: 'Strong coding model with good tool use.', minRam: 8, minVram: 6 },
  { name: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', description: 'Larger coding model.', minRam: 16, minVram: 12 },
  { name: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', description: 'High-end coding model.', minRam: 32, minVram: 24 },
  { name: 'llama3.1:8b', label: 'Llama 3.1 8B', description: 'General model with tool-calling support.', minRam: 8, minVram: 6 },
  { name: 'llama3.1:70b', label: 'Llama 3.1 70B', description: 'Very large general model.', minRam: 48, minVram: 40 },
  { name: 'mistral:7b', label: 'Mistral 7B', description: 'Fast general model with function calling.', minRam: 8, minVram: 6 },
  { name: 'qwen2.5:7b', label: 'Qwen2.5 7B', description: 'General model with tool use.', minRam: 8, minVram: 6 },
  { name: 'gemma2:9b', label: 'Gemma 2 9B', description: "Google's general model.", minRam: 10, minVram: 7 },
  { name: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', description: 'MoE coding model.', minRam: 16, minVram: 12 },
];

// Case-insensitive substring filter over name/label/description; empty query
// returns the whole catalog.
function catalogFilter(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return (catalog || []).slice();
  return (catalog || []).filter((m) =>
    (m.name && m.name.toLowerCase().includes(q))
    || (m.label && m.label.toLowerCase().includes(q))
    || (m.description && m.description.toLowerCase().includes(q)));
}

module.exports = {
  OLLAMA_PREFIX,
  isOllamaId,
  toOllamaId,
  ollamaName,
  mergeModels,
  parsePullProgress,
  CATALOG,
  catalogFilter,
};
