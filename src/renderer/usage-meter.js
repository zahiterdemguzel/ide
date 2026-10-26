import { t } from '../i18n/index.js';
import { isPanelEnabled, onPanelsChanged } from './panels.js';
import { usageLevel } from './shared/account-switch.js';

// --- toolbar usage meter (Claude subscription limits) ---
// Shows the user's remaining usage against the two rolling subscription windows —
// the 5-hour session limit and the weekly limit — as labelled sliders with a
// "resets in …" countdown. The data comes from main's get-usage, which reads the
// Messages API's unified rate-limit response headers (see src/main/usage-parse.js).
// Polled every 30s while this window has focus (a background window shouldn't spend
// a token + round-trip per tick) — or in the background too when `pollInBackground`
// says so (the account auto-switch must see the limit coming while the user is
// away); hidden whenever main returns
// null (no OAuth token, an API-key user, or a transient failure).

const POLL_MS = 30000;
const meter = document.getElementById('usage-meter');

// Stacked top-to-bottom: 5-hour (the window users hit first) on top, weekly below.
const WINDOWS = [
  { key: '5h', labelKey: 'usage.session' },
  { key: '7d', labelKey: 'usage.weekly' },
];

const fills = {}; // key -> { win, label, bar, fill, reset }
let lastView = null; // remembered so a settings toggle can re-render without re-fetching

function build() {
  meter.replaceChildren();
  for (const w of WINDOWS) {
    const win = document.createElement('div');
    win.className = 'um-win';
    const label = document.createElement('span');
    label.className = 'um-label';
    label.dataset.i18n = w.labelKey; // so a language switch re-translates it
    label.textContent = t(w.labelKey);
    const bar = document.createElement('div');
    bar.className = 'um-bar';
    const fill = document.createElement('div');
    fill.className = 'um-fill';
    bar.appendChild(fill);
    const reset = document.createElement('span');
    reset.className = 'um-reset';
    win.append(label, bar, reset);
    meter.appendChild(win);
    fills[w.key] = { win, label, bar, fill, reset };
  }
}

function render(view) {
  // Turned off in settings → stay hidden regardless of whether data is available.
  if (!isPanelEnabled('usage')) { meter.hidden = true; return; }
  if (!view || !view.windows || !view.windows.length) { meter.hidden = true; return; }
  const byKey = Object.fromEntries(view.windows.map((w) => [w.key, w]));
  let any = false;
  for (const w of WINDOWS) {
    const el = fills[w.key];
    const data = byKey[w.key];
    if (!data) { el.win.style.display = 'none'; continue; }
    any = true;
    el.win.style.display = '';
    const pct = Math.round(data.utilization * 100);
    el.fill.style.width = pct + '%';
    el.fill.dataset.level = usageLevel(data.utilization);
    el.reset.textContent = data.resetIn ? t('usage.resetsIn').replace('{t}', data.resetIn) : '';
    // .um-win is display:contents (no box), so the row tooltip rides on its children.
    const tip = `${t(w.labelKey)}: ${pct}% ${t('usage.used')}`
      + (data.resetIn ? ` · ${t('usage.resetsIn').replace('{t}', data.resetIn)}` : '');
    el.label.title = el.bar.title = el.reset.title = tip;
  }
  meter.hidden = !any;
}

async function refresh() {
  // get-usage returns null whenever there's no usable OAuth token — a machine
  // without Claude Code installed (or not yet signed in) — so the meter stays
  // hidden there. Any unexpected error is swallowed and treated the same way.
  let view = null;
  try { view = await window.api?.getUsage?.(); } catch {}
  lastView = view;
  render(view);
  // The account switcher watches each reading to offer a switch near the limit.
  window.dispatchEvent(new CustomEvent('usage-updated', { detail: view }));
}

export function initUsageMeter({ pollInBackground = () => false } = {}) {
  build();
  refresh();
  // Poll every 30s, but skip the tick while this window is in the background so an
  // unfocused app doesn't keep spending a token per round-trip — unless asked to.
  setInterval(() => { if (document.hasFocus() || pollInBackground()) refresh(); }, POLL_MS);
  // Refresh the moment focus returns, so coming back from the background shows
  // current numbers without waiting for the next tick.
  window.addEventListener('focus', refresh);
  // Re-apply visibility when the user flips the meter toggle in settings —
  // no re-fetch, just re-render the data we already have.
  onPanelsChanged(() => render(lastView));
  // A different account has different limits — read them right away.
  window.addEventListener('account-changed', refresh);
}
