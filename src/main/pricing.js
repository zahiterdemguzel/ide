// Pure (Electron-free) Anthropic API list prices, USD per million tokens, used by
// the Settings → Activity panel to price the per-model token usage read from the
// session transcripts. Rates as of June 2026; cache pricing follows the API's
// standard multipliers (5-minute cache write = 1.25× input, cache read = 0.1×
// input). Models are matched by substring rules against the full transcript model
// id (e.g. "claude-opus-4-8"), first hit wins — order matters. An unknown model
// yields null so the UI can show its tokens with the cost marked unknown instead
// of a silently wrong number. Unit-tested in test/pricing.test.js.
const MODEL_RATES = [
  { match: /fable|mythos/, input: 10, output: 50 },
  { match: /opus-4-[5-9]/, input: 5, output: 25 },
  { match: /opus/, input: 15, output: 75 }, // Opus 4.1 and older, Claude 3 Opus
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku-4/, input: 1, output: 5 },
  { match: /3-5-haiku|haiku-3-5/, input: 0.8, output: 4 },
  { match: /haiku/, input: 0.25, output: 1.25 },
];

// { input, output, cacheWrite, cacheRead } in USD per MTok, or null when unknown.
function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  const r = MODEL_RATES.find((x) => x.match.test(m));
  if (!r) return null;
  return { input: r.input, output: r.output, cacheWrite: r.input * 1.25, cacheRead: r.input * 0.1 };
}

// Price a token bundle { input, output, cacheWrite, cacheRead } (token counts) in
// USD, or null when the model's rates are unknown.
function costUsd(model, tokens) {
  const r = ratesFor(model);
  if (!r || !tokens) return null;
  return ((tokens.input || 0) * r.input
    + (tokens.output || 0) * r.output
    + (tokens.cacheWrite || 0) * r.cacheWrite
    + (tokens.cacheRead || 0) * r.cacheRead) / 1e6;
}

module.exports = { MODEL_RATES, ratesFor, costUsd };
