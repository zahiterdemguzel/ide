// Pure, DOM-free matcher for the Command Palette (renderer/command-palette.js).
// Kept Electron- and DOM-free so it can be unit-tested (see docs/testing.md) the
// same way as fuzzy.js / git-status.js.
//
// A command is { id, title, keywords } (title and keywords already localized by
// the caller). We fuzzy-match the query against the visible title first — a title
// hit ranks by its own score and contributes the highlight positions — and fall
// back to the hidden keywords so a synonym ("preferences" for "Settings") still
// finds the command, just ranked below any title match and without highlights.

import { fuzzyMatch } from './fuzzy.js';

// Keyword-only matches must never outrank a genuine title match, so their score
// is pushed below any title hit's floor.
const KEYWORD_PENALTY = 1000;

// Rank `commands` against `query`, best first, keeping at most `limit`. Each
// result is { command, positions } where positions index into command.title (for
// bolding); a keyword-only match has empty positions. An empty query returns the
// head of the list unscored, so opening the palette shows every command in order.
export function matchCommands(query, commands, limit = 50) {
  const q = (query || '').trim();
  if (!q) return commands.slice(0, limit).map((command) => ({ command, positions: [] }));

  const scored = [];
  for (const command of commands) {
    const titleM = fuzzyMatch(q, command.title);
    if (titleM) {
      scored.push({ command, score: titleM.score, positions: titleM.positions });
      continue;
    }
    const kwM = command.keywords ? fuzzyMatch(q, command.keywords) : null;
    if (kwM) scored.push({ command, score: kwM.score - KEYWORD_PENALTY, positions: [] });
  }

  scored.sort((a, b) =>
    b.score - a.score || a.command.title.length - b.command.title.length
    || (a.command.title < b.command.title ? -1 : 1));
  return scored.slice(0, limit).map(({ command, positions }) => ({ command, positions }));
}
