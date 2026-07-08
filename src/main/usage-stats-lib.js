// Pure (Electron-free) aggregation of Claude Code transcript files into
// per-model token totals, for the Settings → Activity panel. The fs/IPC glue
// lives in usage-stats.js. Unit-tested in test/usage-stats-lib.test.js.

// Claude Code stores transcripts under ~/.claude/projects/<munged cwd>/<session
// id>.jsonl, where the cwd is munged by replacing every non-alphanumeric
// character with '-' (verified against real installs — e.g. a Turkish "Masaüstü"
// path segment becomes "Masa-st-").
function projectDirName(projectPath) {
  return String(projectPath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Fold one transcript's JSONL text into `acc` (Map<model, tokens>), where tokens
// is { input, output, cacheWrite, cacheRead }. Only assistant entries carry
// `message.usage`. A resume rewrites earlier lines into the same file (and an
// aborted stream can log the same API call twice), so entries are deduped across
// every transcript by message.id + requestId via the shared `seen` set; entries
// with neither id are kept (better to count once than drop). Synthetic rows
// (model names like "<synthetic>") carry no billable usage and are skipped.
function accumulateTranscript(text, acc, seen) {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj && obj.message;
    const u = msg && msg.usage;
    if (!u || !msg.model || msg.model.startsWith('<')) continue;
    const key = `${msg.id || ''}:${obj.requestId || ''}`;
    if (key !== ':') {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const t = acc.get(msg.model) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    acc.set(msg.model, t);
  }
}

function totalTokens(t) {
  return (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0);
}

module.exports = { projectDirName, accumulateTranscript, totalTokens };
