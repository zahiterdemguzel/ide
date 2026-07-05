'use strict';

// Pure, Electron-free parsing of Anthropic's unified rate-limit response headers
// into the usage-meter view model. Unit-tested in test/usage-parse.test.js.
//
// Every /v1/messages response to an OAuth/subscription token carries the user's
// subscription utilization across two rolling windows (verified against a live
// response — count_tokens does NOT return these, only a real messages call does):
//   anthropic-ratelimit-unified-5h-utilization   "0".."1" fraction used
//   anthropic-ratelimit-unified-5h-reset          epoch SECONDS the 5h window resets
//   anthropic-ratelimit-unified-7d-utilization   "0".."1" fraction used
//   anthropic-ratelimit-unified-7d-reset          epoch SECONDS the 7d window resets
//   anthropic-ratelimit-unified-representative-claim   "five_hour" | "seven_day"
//   anthropic-ratelimit-unified-status                 "allowed" | "allowed_warning" | "rejected"
//   anthropic-ratelimit-unified-reset                  epoch SECONDS the bottleneck window resets
// reset values are accepted as either epoch seconds or an ISO date string, so a
// future format tweak doesn't silently break the countdown.
//
// These headers ride on EVERY /v1/messages response, including the 429 you get
// once you're out of usage — so the caller reads them regardless of HTTP status.
// A hard 429 rejection can drop the per-window utilization headers and report only
// the overall `-status: rejected` + `-reset`; we synthesize a maxed-out window
// from those so the meter still shows "100% · resets in …" instead of vanishing
// exactly when the limit is hit.

const WINDOWS = [
  { key: '5h', util: 'anthropic-ratelimit-unified-5h-utilization', reset: 'anthropic-ratelimit-unified-5h-reset' },
  { key: '7d', util: 'anthropic-ratelimit-unified-7d-utilization', reset: 'anthropic-ratelimit-unified-7d-reset' },
];

// Which window key the server flags as the current bottleneck.
const CLAIM_KEY = { five_hour: '5h', seven_day: '7d' };

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

// → epoch milliseconds, or null. Accepts epoch seconds (number-ish) or ISO 8601.
function resetMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000; // header carries epoch seconds
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Build the raw view model from a header bag (Node lowercases header keys).
// Returns null when the unified headers are absent (an API-key token, a non-200
// response, or a transport error) so the caller can hide the meter rather than
// render misleading zeros.
function parseUsageHeaders(headers = {}) {
  const get = (k) => headers[k] ?? headers[k.toLowerCase()];
  const windows = [];
  for (const w of WINDOWS) {
    const raw = get(w.util);
    const util = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(util)) continue;
    windows.push({ key: w.key, utilization: clamp01(util), resetAt: resetMs(get(w.reset)) });
  }
  const representative = CLAIM_KEY[get('anthropic-ratelimit-unified-representative-claim')] || null;
  if (windows.length) return { windows, representative };

  // Out of usage: a rejected request may omit the per-window utilization headers
  // and report only the overall status + reset. Synthesize a fully-used window off
  // the representative claim (default 5h) so the meter still shows the limit and
  // its reset countdown rather than hiding. Require a concrete reset so a bare
  // status with no quantitative data doesn't render a contentless bar.
  const rejectedReset = /reject/i.test(String(get('anthropic-ratelimit-unified-status') || ''))
    ? resetMs(get('anthropic-ratelimit-unified-reset')) : null;
  if (rejectedReset != null) {
    const key = representative || '5h';
    return { windows: [{ key, utilization: 1, resetAt: rejectedReset }], representative: key };
  }
  return null;
}

// Compact, locale-neutral "time until reset": "24m", "13h", "2d", or "now".
// nowMs is passed in (no Date.now() in the pure layer, so the test is deterministic).
function formatResetShort(resetAtMs, nowMs) {
  if (resetAtMs == null) return '';
  const s = Math.round((resetAtMs - nowMs) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

// The renderer-facing model: each window carries its fraction used, a compact
// reset token, the raw reset timestamp, and whether it is the current bottleneck.
function usageView(headers, nowMs) {
  const parsed = parseUsageHeaders(headers);
  if (!parsed) return null;
  return {
    windows: parsed.windows.map((w) => ({
      key: w.key,
      utilization: w.utilization,
      resetIn: formatResetShort(w.resetAt, nowMs),
      resetAt: w.resetAt,
      representative: w.key === parsed.representative,
    })),
  };
}

module.exports = { parseUsageHeaders, formatResetShort, usageView, resetMs };
