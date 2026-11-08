// Pure decisions behind the toolbar account switcher (src/renderer/accounts.js):
// when to offer a switch, which accounts to offer first, and how usage reads.
// Tested in test/account-switch.test.mjs.

// The 5-hour window this full means the session is about to stall — offer a switch.
export const SWITCH_THRESHOLD = 0.95;

export function fiveHourUtilization(view) {
  const win = view && Array.isArray(view.windows) && view.windows.find((w) => w.key === '5h');
  return win && typeof win.utilization === 'number' ? win.utilization : null;
}

// The windows an account row shows, in display order (5-hour above weekly), each
// with its fraction used and compact reset countdown. Windows the reading lacks, or
// whose utilization is unknown, are left out; no reading gives an empty list.
const ROW_WINDOW_ORDER = ['5h', '7d'];
export function rowUsageWindows(view) {
  if (!view || !Array.isArray(view.windows)) return [];
  return ROW_WINDOW_ORDER
    .map((key) => view.windows.find((w) => w.key === key))
    .filter((w) => w && typeof w.utilization === 'number')
    .map((w) => ({ key: w.key, utilization: w.utilization, resetIn: w.resetIn || '' }));
}

// A key naming "this account crossed the threshold in this 5-hour window", or null
// when it hasn't. Asking once per key means a "Not now" holds until the window
// resets, instead of re-asking on every 30s poll.
export function switchPromptKey(accountId, view, threshold = SWITCH_THRESHOLD) {
  const util = fiveHourUtilization(view);
  if (!accountId || util === null || util < threshold) return null;
  const win = view.windows.find((w) => w.key === '5h');
  return `${accountId}:${win.resetAt ?? ''}`;
}

// Past this, the app stops asking and switches on its own (the user may be away
// with sessions running unattended) — but only to an account the user allowed
// for auto-switching (see pickAutoSwitchTarget).
export const AUTO_SWITCH_THRESHOLD = 0.98;

// A key naming "this account crossed the auto-switch threshold in this window", or
// null. Any window counts: a full weekly window stalls a session as surely as a full
// 5-hour one. One key per window + reset, so each limit switches once.
export function autoSwitchKey(accountId, view, threshold = AUTO_SWITCH_THRESHOLD) {
  if (!accountId || !view || !Array.isArray(view.windows)) return null;
  const full = view.windows.find((w) => typeof w.utilization === 'number' && w.utilization >= threshold);
  return full ? `${accountId}:auto:${full.key}:${full.resetAt ?? ''}` : null;
}

// The highest utilization across all of a reading's windows (5-hour, weekly…), or
// null when none is known.
function busiestWindowUtilization(view) {
  const known = view && Array.isArray(view.windows)
    ? view.windows.map((w) => w.utilization).filter((u) => typeof u === 'number')
    : [];
  return known.length ? Math.max(...known) : null;
}

// The account to switch to automatically, or null when none qualifies. Strict on
// purpose — nobody is there to correct a bad pick: the user allowed it for
// auto-switching (`autoSwitch !== false`), signed in, a fresh usage reading, and
// every window (5-hour and weekly) below the prompt threshold so it isn't about to
// need a switch itself. A maxed-out reading synthesized from a rejected request has
// a single window at 100%, so the headroom rule keeps it out.
export function pickAutoSwitchTarget(accounts, usageById, activeId) {
  const eligible = rankSwitchTargets(accounts, usageById, activeId).filter(({ account, utilization }) => {
    const busiest = busiestWindowUtilization(usageById && usageById[account.id]);
    return account.loggedIn && account.autoSwitch !== false
      && utilization !== null && busiest !== null && busiest < SWITCH_THRESHOLD;
  });
  return eligible.length ? eligible[0].account : null;
}

// The accounts worth switching to, best first: signed-in before signed-out, then
// the most 5-hour headroom, with unknown usage after known.
export function rankSwitchTargets(accounts, usageById, activeId) {
  return accounts
    .filter((a) => a.id !== activeId)
    .map((a) => ({ account: a, utilization: fiveHourUtilization(usageById && usageById[a.id]) }))
    .sort((x, y) => {
      if (x.account.loggedIn !== y.account.loggedIn) return x.account.loggedIn ? -1 : 1;
      if (x.utilization === null || y.utilization === null) {
        return (x.utilization === null) - (y.utilization === null);
      }
      return x.utilization - y.utilization;
    });
}

// Meter colouring, shared by the toolbar meter and the switcher: ≥80% critical,
// ≥50% warning, otherwise healthy.
export function usageLevel(utilization) {
  return utilization >= 0.8 ? 'crit' : utilization >= 0.5 ? 'warn' : 'ok';
}

// One or two letters for an account's avatar ("Work Mail" → "WM").
export function accountInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

// A key naming "this login of this account has expired", or null while it's fine.
// The re-login question is asked once per key: dismissing it holds until the user
// signs in again (a new login carries a new stamp) and that one expires too.
export function reloginPromptKey(account) {
  if (!account || account.login !== 'expired') return null;
  return `${account.id}:${account.loginStamp ?? ''}`;
}
