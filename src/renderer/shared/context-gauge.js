// The session bar's context badge: how full the active session's context window
// is, live while it runs. Main forwards the numbers the session's statusLine
// script reports (session-context, see hook-server.js); this turns them into the
// badge's text and warning level. Pure (DOM-free) so it stays unit-tested
// (test/context-gauge.test.mjs).

// Fill levels at which the badge turns amber, then red — near the point where
// Claude Code starts auto-compacting.
export const CONTEXT_WARN_PERCENT = 70;
export const CONTEXT_CRITICAL_PERCENT = 90;

// What the badge text shows (Settings → Sessions → Context & usage). The tooltip
// always carries both, whichever is picked.
export const CONTEXT_BADGE_MODES = ['tokens', 'percent', 'both'];
export const DEFAULT_CONTEXT_BADGE_MODE = 'tokens';

export function cleanContextBadgeMode(mode) {
  return CONTEXT_BADGE_MODES.includes(mode) ? mode : DEFAULT_CONTEXT_BADGE_MODE;
}

function compactTokens(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

const clampPercent = (p) => Math.round(Math.min(Math.max(p, 0), 100));

// { text, detail, level } for the badge, or null when there's nothing to show
// yet (a session that hasn't made a call). `text` follows `mode`, falling back
// to whichever half is known; `detail` (the tooltip) is the full reading,
// e.g. `42% · 84k / 200k tokens`.
export function contextBadge(context, mode = DEFAULT_CONTEXT_BADGE_MODE) {
  if (!context) return null;
  const { usedTokens, windowSize, percent } = context;
  const pct = Number.isFinite(percent) ? `${clampPercent(percent)}%` : null;
  const tokens = Number.isFinite(usedTokens)
    ? (windowSize ? `${compactTokens(usedTokens)} / ${compactTokens(windowSize)}` : compactTokens(usedTokens))
    : null;
  if (!pct && !tokens) return null;
  const shown = cleanContextBadgeMode(mode);
  let text;
  if (shown === 'both' && pct && tokens) text = `${pct} · ${tokens}`;
  else if (shown === 'percent') text = pct || tokens;
  else text = tokens || pct;
  const detail = [pct, tokens && `${tokens} tokens`].filter(Boolean).join(' · ');
  return { text, detail, level: contextLevel(percent) };
}

export function contextLevel(percent) {
  if (!Number.isFinite(percent)) return 'normal';
  if (percent >= CONTEXT_CRITICAL_PERCENT) return 'critical';
  if (percent >= CONTEXT_WARN_PERCENT) return 'warn';
  return 'normal';
}
