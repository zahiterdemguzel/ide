// Pure (Electron-free) helpers for the per-session status line: summing token
// usage out of a Claude Code transcript and formatting the `model · tokens · $`
// string. Kept apart from the runnable script (statusline-script.js) so it stays
// unit-tested (test/statusline-lib.test.js) and so the copy staged on disk can
// require it as a sibling.

// Sum every API call's token usage in a transcript (JSONL, one entry per line).
// Each assistant entry carries `message.usage`; summing all four token classes
// across all calls yields the total tokens billed for the session — the same
// basis the session's cost is computed on (the growing context is re-sent each
// call, so the per-call input counts are genuinely additive, not double-counted).
function sumTranscriptTokens(text) {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
    const u = entry && entry.message && entry.message.usage;
    if (!u) continue;
    total += (u.input_tokens || 0) + (u.output_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return total;
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
// When `width` (the terminal column count, from $COLUMNS) is known, the model
// sits on the left and the `$cost · tokens` block is pushed to the right edge,
// padded between them. Putting the padding in the *middle* (not leading) keeps
// the right-alignment intact even if Claude trims leading/trailing whitespace.
// `margin` reserves columns at the right so the metrics never sit flush against
// the edge (where Claude's padding / a last-cell wrap can clip them). The cost
// comes before the token count so, in a right-aligned line, edge-truncation eats
// into the (less critical) token count and the dollar — to its left — stays fully
// visible. Without a usable width it falls back to a ` · `-joined inline line.
function formatStatusLine({ model, tokens, cost, width, margin = 0 }) {
  const tokStr = `${formatTokens(tokens || 0)} tokens`;
  const metrics = `${formatCost(cost || 0)} · ${tokStr}`;
  const left = model || '';
  const target = Number(width) - margin;
  if (Number.isFinite(target) && target > 0) {
    const gap = target - left.length - metrics.length;
    if (gap >= 1) return left + ' '.repeat(gap) + metrics;
  }
  return left ? `${left} · ${metrics}` : metrics;
}

module.exports = { sumTranscriptTokens, formatTokens, formatCost, formatStatusLine };
