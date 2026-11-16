'use strict';

// Pure, Electron-free logic behind the spending limit of API-key accounts (see
// .claude/memory/accounts.md → "Spending limit"). Unit-tested in
// test/api-spend-lib.test.js.
//
// API-key sessions send their traffic through the account proxy, which reads the
// `usage` block of every Messages response (createUsageReader), prices it
// (costOfUsage) and adds it to the account's budget (addSpend). The budget then
// reads like one more usage window ('budget'), so the toolbar meter, the account
// menu and the 98% auto-switch treat it like a subscription limit.

const { formatResetShort } = require('./usage-parse');

// USD per million tokens: [input, output, cache read]. Cache writes are priced off
// the input rate (1.25× for the 5-minute TTL, 2× for 1-hour). Anthropic first-party
// list prices as of 2026-11; the most specific id prefix wins.
const MODEL_PRICES = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-opus-4-5': [5, 25, 0.5],
  'claude-opus-4': [15, 75, 1.5],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
  'claude-3-5-haiku': [0.8, 4, 0.08],
};
// An unknown id is priced as the newest model of its family, else as Opus.
const FAMILY_FALLBACK = [
  ['fable', 'claude-fable-5-2'], ['mythos', 'claude-mythos-5-2'], ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'],
];
const PRICE_KEYS_LONGEST_FIRST = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const FAST_MODE_MULTIPLIER = 2;
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;
// Haiku 5.5 bills prompts above 100K tokens at five times its base rates.
const HAIKU_5_5_LONG_PROMPT_TOKENS = 100000;
const HAIKU_5_5_LONG_PROMPT_MULTIPLIER = 5;

function priceKeyFor(model) {
  const id = String(model || '').toLowerCase();
  const exact = PRICE_KEYS_LONGEST_FIRST.find((key) => id.startsWith(key));
  if (exact) return exact;
  const family = FAMILY_FALLBACK.find(([word]) => id.includes(word));
  return family ? family[1] : 'claude-opus-5-5';
}

const count = (n) => (typeof n === 'number' && n > 0 ? n : 0);

// The USD cost of one response's `usage` block for `model`.
function costOfUsage(model, usage) {
  if (!usage) return 0;
  const key = priceKeyFor(model);
  let [inputRate, outputRate, cacheReadRate] = MODEL_PRICES[key];
  const input = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation || {};
  const write1h = Math.min(cacheWrite, count(breakdown.ephemeral_1h_input_tokens));
  const write5m = cacheWrite - write1h;
  if (key === 'claude-haiku-5-5' && input + cacheRead + cacheWrite > HAIKU_5_5_LONG_PROMPT_TOKENS) {
    inputRate *= HAIKU_5_5_LONG_PROMPT_MULTIPLIER;
    outputRate *= HAIKU_5_5_LONG_PROMPT_MULTIPLIER;
    cacheReadRate *= HAIKU_5_5_LONG_PROMPT_MULTIPLIER;
  }
  let tokensUsd = (input * inputRate
    + cacheRead * cacheReadRate
    + write5m * inputRate * CACHE_WRITE_5M_MULTIPLIER
    + write1h * inputRate * CACHE_WRITE_1H_MULTIPLIER
    + count(usage.output_tokens) * outputRate) / 1e6;
  if (usage.speed === 'fast') tokensUsd *= FAST_MODE_MULTIPLIER;
  const searches = count(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  return tokensUsd + searches * WEB_SEARCH_USD_PER_REQUEST;
}

// Later usage fields override earlier ones, but a field a later event leaves out
// (or sends as null) keeps its earlier value.
function mergeUsage(into, next) {
  if (!next || typeof next !== 'object') return into;
  const merged = { ...into };
  for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) merged[k] = v;
  return merged;
}

// Collects the model and final usage of one Messages response as its body streams
// by — a server-sent-event stream (`message_start` then `message_delta` events) or
// a plain JSON body. Fed raw chunks; `result()` → { model, usage } or null.
function createUsageReader(contentType) {
  const streaming = /event-stream/i.test(contentType || '');
  let buffered = '';
  let model = '';
  let usage = null;

  const takeEvent = (data) => {
    if (data.type === 'message_start' && data.message) {
      model = data.message.model || model;
      usage = mergeUsage(usage || {}, data.message.usage);
    } else if (data.type === 'message_delta' && data.usage) {
      usage = mergeUsage(usage || {}, data.usage);
    }
  };

  const takeLines = (block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { takeEvent(JSON.parse(line.slice(5).trim())); } catch { /* not JSON: ignore */ }
    }
  };

  return {
    feed(chunk) {
      buffered += chunk.toString('utf8');
      if (!streaming) return;
      buffered = buffered.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        takeLines(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
      }
    },
    result() {
      if (streaming) takeLines(buffered);
      else {
        try {
          const body = JSON.parse(buffered);
          if (body && body.usage) { model = body.model || ''; usage = body.usage; }
        } catch { /* not a JSON body */ }
      }
      buffered = '';
      return usage ? { model, usage } : null;
    },
  };
}

// --- the budget ---
// { limitUsd (0 = no limit), period: 'month' | 'total', spentUsd, periodStart (ms) }.
// A monthly budget starts over on the 1st (local time); a total one only when the
// user resets it.

const BUDGET_PERIODS = ['month', 'total'];

function monthStart(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function nextMonthStart(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function normalizeBudget(raw, nowMs) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    limitUsd: num(b.limitUsd),
    period: BUDGET_PERIODS.includes(b.period) ? b.period : 'month',
    spentUsd: num(b.spentUsd),
    periodStart: num(b.periodStart) || monthStart(nowMs),
  };
}

// The budget as of `nowMs`: a monthly one whose month is over starts again at $0.
function currentBudget(raw, nowMs) {
  const budget = normalizeBudget(raw, nowMs);
  if (budget.period === 'month' && budget.periodStart < monthStart(nowMs)) {
    return { ...budget, spentUsd: 0, periodStart: monthStart(nowMs) };
  }
  return budget;
}

function addSpend(raw, usd, nowMs) {
  const budget = currentBudget(raw, nowMs);
  return { ...budget, spentUsd: budget.spentUsd + count(usd) };
}

// A new limit and/or period; switching to monthly drops what earlier months spent.
function withLimit(raw, { limitUsd, period }, nowMs) {
  const budget = currentBudget(raw, nowMs);
  const nextPeriod = BUDGET_PERIODS.includes(period) ? period : budget.period;
  const limit = typeof limitUsd === 'number' && Number.isFinite(limitUsd) && limitUsd > 0 ? limitUsd : 0;
  const restart = nextPeriod === 'month' && budget.period !== 'month';
  return {
    ...budget,
    limitUsd: limit,
    period: nextPeriod,
    ...(restart ? { spentUsd: 0, periodStart: monthStart(nowMs) } : {}),
  };
}

function resetSpend(raw, nowMs) {
  return { ...currentBudget(raw, nowMs), spentUsd: 0, periodStart: monthStart(nowMs) };
}

function isOverBudget(raw, nowMs) {
  const budget = currentBudget(raw, nowMs);
  return budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd;
}

// The budget as a usage reading (the shape usage-parse.js gives subscription
// limits), so every meter can draw it; null without a limit.
function budgetUsageView(raw, nowMs) {
  const budget = currentBudget(raw, nowMs);
  if (!budget.limitUsd) return null;
  const resetAt = budget.period === 'month' ? nextMonthStart(nowMs) : null;
  return {
    windows: [{
      key: 'budget',
      utilization: Math.min(1, budget.spentUsd / budget.limitUsd),
      resetIn: formatResetShort(resetAt, nowMs),
      resetAt,
      representative: true,
      spentUsd: budget.spentUsd,
      limitUsd: budget.limitUsd,
      period: budget.period,
    }],
  };
}

// The error a session gets once its account's limit is spent: the 400 shape the
// API itself uses for "credit balance too low", so the CLI shows the message and
// stops instead of retrying.
function overBudgetError(limitUsd) {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `This account's spending limit ($${limitUsd.toFixed(2)}) is used up. Raise or reset it from the account menu, or switch accounts.`,
    },
  };
}

module.exports = {
  MODEL_PRICES, priceKeyFor, costOfUsage, createUsageReader,
  normalizeBudget, currentBudget, addSpend, withLimit, resetSpend, isOverBudget,
  budgetUsageView, overBudgetError,
};
