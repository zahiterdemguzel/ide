// Pure (Electron-free) helpers for the per-session status line: summing token
// usage out of a Claude Code transcript, resolving the live context-window fill,
// and formatting the `model · ctx % … $ · tokens` string. Kept apart from the runnable script (statusline-script.js) so it stays
// unit-tested (test/statusline-lib.test.js) and so the copy staged on disk can
// require it as a sibling.

// Tokens one API call put into the model's context window: everything it read
// (fresh, cache-written and cache-read input). Output isn't counted — it only
// joins the context once the next call re-sends it as input.
function contextTokensOf(usage) {
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

// One pass over a transcript (JSONL, one entry per line) yielding:
// - totalTokens: every API call's usage summed across all four token classes —
//   the total billed for the session, the same basis its cost is computed on
//   (the growing context is re-sent each call, so per-call input counts are
//   genuinely additive, not double-counted).
// - lastContextTokens: the context size of the most recent main-thread call
//   (sidechain/subagent calls have their own, separate context), or null when
//   there's no call yet. The fallback for the context gauge when Claude's stdin
//   carries no `context_window`.
// Claude Code writes one transcript line per content block (thinking, text,
// tool_use) of a single API response, each repeating that response's usage, so
// entries are keyed by `message.id` and only the last copy of each is counted.
function summarizeTranscript(text) {
  const usageByMessage = new Map();
  let anonymousCount = 0;
  let lastContextTokens = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
    const u = entry && entry.message && entry.message.usage;
    if (!u) continue;
    usageByMessage.set(entry.message.id || `anonymous-${anonymousCount++}`, u);
    if (!entry.isSidechain) lastContextTokens = contextTokensOf(u);
  }
  let totalTokens = 0;
  for (const u of usageByMessage.values()) {
    totalTokens += contextTokensOf(u) + (u.output_tokens || 0);
  }
  return { totalTokens, lastContextTokens };
}

function sumTranscriptTokens(text) {
  return summarizeTranscript(text).totalTokens;
}

// The current context-window fill as { usedTokens, windowSize, percent }, or
// null when nothing is known yet. Prefers Claude's own stdin `context_window`
// (its pre-computed `used_percentage` matches what /context reports); falls back
// to the transcript's last call when stdin lacks it (older Claude Code builds).
// windowSize/percent are null when only the token count is known.
function resolveContextUsage(contextWindow, fallbackTokens) {
  const cw = contextWindow && typeof contextWindow === 'object' ? contextWindow : {};
  const windowSize = cw.context_window_size > 0 ? cw.context_window_size : null;
  const usedTokens = cw.current_usage && typeof cw.current_usage === 'object'
    ? contextTokensOf(cw.current_usage)
    : (Number.isFinite(fallbackTokens) ? fallbackTokens : null);
  let percent = Number.isFinite(cw.used_percentage) ? cw.used_percentage : null;
  if (percent === null && usedTokens !== null && windowSize) percent = (usedTokens / windowSize) * 100;
  if (usedTokens === null && percent === null) return null;
  return { usedTokens, windowSize, percent };
}

// The context report the statusLine script POSTs to the hook server, cleaned of
// anything that isn't a finite non-negative number (the payload crosses a
// process boundary, so it's treated as untrusted). Null when nothing usable is
// left.
function sanitizeContextReport(report) {
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const r = report && typeof report === 'object' ? report : {};
  const clean = { usedTokens: num(r.usedTokens), windowSize: num(r.windowSize) || null, percent: num(r.percent) };
  return clean.usedTokens === null && clean.percent === null ? null : clean;
}

// `ctx 42% (84k/200k)`, degrading to `ctx 42%` or `ctx 84k` with less data.
function formatContext(context) {
  if (!context) return '';
  const { usedTokens, windowSize, percent } = context;
  const pct = percent === null ? null : `${Math.round(Math.min(Math.max(percent, 0), 100))}%`;
  const sizes = usedTokens !== null && windowSize
    ? `${formatTokens(usedTokens)}/${formatTokens(windowSize)}`
    : (usedTokens !== null ? formatTokens(usedTokens) : null);
  if (pct && sizes && windowSize) return `ctx ${pct} (${sizes})`;
  return `ctx ${pct || sizes}`;
}

// Compact a token count: 850, 12.3k, 1.23M.
function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

// Compact a dollar amount: extra precision while it's tiny so a cheap session
// doesn't read as a flat $0.00.
function formatCost(usd) {
  if (!(usd > 0)) return '$0.00';
  return '$' + (usd >= 1 ? usd.toFixed(2) : usd.toFixed(4));
}

// The single status-line string Claude renders at the bottom of the session.
// The left half is the model plus the live context gauge (`context`, from
// resolveContextUsage) — on the left so edge-truncation never clips it.
// When `width` (the terminal column count, from $COLUMNS) is known, the model
// sits on the left and the `$cost · tokens` block is pushed to the right edge,
// padded between them. Putting the padding in the *middle* (not leading) keeps
// the right-alignment intact even if Claude trims leading/trailing whitespace.
// `margin` reserves columns at the right so the metrics never sit flush against
// the edge (where Claude's padding / a last-cell wrap can clip them). The cost
// comes before the token count so, in a right-aligned line, edge-truncation eats
// into the (less critical) token count and the dollar — to its left — stays fully
// visible. Without a usable width it falls back to a ` · `-joined inline line.
function formatStatusLine({ model, tokens, cost, context, width, margin = 0 }) {
  const tokStr = `${formatTokens(tokens || 0)} tokens`;
  const metrics = `${formatCost(cost || 0)} · ${tokStr}`;
  const left = [model, formatContext(context)].filter(Boolean).join(' · ');
  const target = Number(width) - margin;
  if (Number.isFinite(target) && target > 0) {
    const gap = target - left.length - metrics.length;
    if (gap >= 1) return left + ' '.repeat(gap) + metrics;
  }
  return left ? `${left} · ${metrics}` : metrics;
}

module.exports = {
  summarizeTranscript, sumTranscriptTokens, resolveContextUsage, formatContext, sanitizeContextReport,
  formatTokens, formatCost, formatStatusLine,
};
