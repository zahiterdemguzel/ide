// When the phone suggests switching Claude account, and to which one. Mirrors the
// desktop's 95% prompt rules (src/renderer/shared/account-switch.js — Metro can't
// reach outside mobile/, so the rule is restated here and
// test/mobile-account-switch.test.mjs pins the two together):
// - only at ≥95% of the active account's 5-hour window,
// - only to another account that is signed in right now (an expired login reports
//   `loggedIn: false`, so it is never offered),
// - best first: the most 5-hour headroom, unknown usage after known.
// Plain JS so the node:test suite can import it.

export const SWITCH_THRESHOLD = 0.95;

/**
 * @typedef {{ key: string, utilization: number, resetAt?: number | null }} UsageWindow
 * @typedef {{ windows: UsageWindow[] } | null | undefined} UsageView
 * @typedef {{ id: string, name: string, loggedIn: boolean, login?: string }} Account
 */

/** @param {UsageView} view */
export function fiveHourUtilization(view) {
  const win = view && Array.isArray(view.windows) && view.windows.find((w) => w.key === '5h');
  return win && typeof win.utilization === 'number' ? win.utilization : null;
}

/**
 * "This account crossed the threshold in this 5-hour window", or null. One key per
 * window, so a dismissed suggestion stays dismissed until the window resets.
 * @param {string | null | undefined} accountId
 * @param {UsageView} view
 */
export function switchSuggestionKey(accountId, view) {
  const util = fiveHourUtilization(view);
  if (!accountId || util === null || util < SWITCH_THRESHOLD) return null;
  const win = view.windows.find((w) => w.key === '5h');
  return `${accountId}:${win.resetAt ?? ''}`;
}

/**
 * The signed-in accounts other than the active one, best first.
 * @param {Account[]} accounts
 * @param {Record<string, UsageView>} usageById
 * @param {string | null} activeId
 * @returns {{ account: Account, utilization: number | null }[]}
 */
export function switchTargets(accounts, usageById, activeId) {
  return (accounts || [])
    .filter((a) => a.id !== activeId && a.loggedIn)
    .map((a) => ({ account: a, utilization: fiveHourUtilization(usageById && usageById[a.id]) }))
    .sort((x, y) => {
      if (x.utilization === null || y.utilization === null) {
        return Number(x.utilization === null) - Number(y.utilization === null);
      }
      return x.utilization - y.utilization;
    });
}

/**
 * The account to suggest, or null when the active one isn't near its limit or no
 * other account could take over. A target that is itself past the threshold isn't
 * worth suggesting — switching would only move the problem.
 * @param {{ activeId: string | null, accounts: Account[], view: UsageView, usageById?: Record<string, UsageView> }} input
 * @returns {{ key: string, target: Account } | null}
 */
export function suggestSwitch({ activeId, accounts, view, usageById = {} }) {
  const key = switchSuggestionKey(activeId, view);
  if (!key) return null;
  const best = switchTargets(accounts, usageById, activeId)
    .find((t) => t.utilization === null || t.utilization < SWITCH_THRESHOLD);
  return best ? { key, target: best.account } : null;
}
