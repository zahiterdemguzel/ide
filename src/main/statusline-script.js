// Runnable Claude Code statusLine command. Claude pipes the session's status JSON
// to this script's stdin on each refresh; whatever it prints becomes the line at
// the bottom of that session's terminal. It sums the session's cumulative tokens
// from the transcript and pairs them with Claude Code's own cumulative cost.
//
// main/statusline.js stages a copy of this file (and statusline-lib.js) on real
// disk and wires `node <thisfile>` into each session's `claude --settings`
// statusLine config — so it never touches the user's global settings.
const fs = require('fs');
const { sumTranscriptTokens, formatStatusLine } = require('./statusline-lib');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let data = {};
  // Strip a leading BOM some shells prepend, then parse; bad/empty stdin -> defaults.
  if (input.charCodeAt(0) === 0xFEFF) input = input.slice(1);
  try { data = JSON.parse(input); } catch {}

  // Tokens are cumulative-per-session, which Claude only exposes in the transcript
  // (the stdin `context_window` counts are *current context*, not the session
  // total). Cost is already cumulative on stdin, so take it verbatim.
  let tokens = 0;
  if (data.transcript_path) {
    try { tokens = sumTranscriptTokens(fs.readFileSync(data.transcript_path, 'utf8')); } catch {}
  }
  const cost = data.cost && data.cost.total_cost_usd;
  const model = data.model && data.model.display_name;
  // Claude Code sets $COLUMNS to the terminal width before running this (stdout
  // is piped, so process.stdout.columns is unset); used to right-align the metrics.
  const width = parseInt(process.env.COLUMNS, 10);

  // Reserve a column at the right so the metrics aren't clipped flush against the
  // edge (the cost sits left of the token count, so the count takes any clipping).
  process.stdout.write(formatStatusLine({ model, tokens, cost, width, margin: 1 }));
});
