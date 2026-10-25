// Pure decisions behind the toolbar account switcher (src/renderer/accounts.js):
// when to offer a switch, which accounts to offer first, and how usage reads.
// Tested in test/account-switch.test.mjs.

// The 5-hour window this full means the session is about to stall — offer a switch.
export const SWITCH_THRESHOLD = 0.95;

export function fiveHourUtilization(view) {
  const win = view && Array.isArray(view.windows) && view.windows.find((w) => w.key === '5h');
  return win && typeof win.utilization === 'number' ? win.utilization : null;
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
