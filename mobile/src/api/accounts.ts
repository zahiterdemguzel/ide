// The desktop's Claude accounts, from the phone: who is signed in, how much of each
// account's usage is gone, and switching which one this desktop window runs under —
// the phone's version of the toolbar account pill (src/renderer/accounts.js).
// Adding, removing and signing in stay desktop-only (sign-in needs a terminal).
//
// Two consumers:
// - UsagePanel lists the accounts with their usage and a Switch button
//   (`useAccounts`).
// - Every header watches for the active account crossing 95% of its 5-hour window
//   while another signed-in account has room (`useSwitchSuggestion`) — the
//   desktop's switch prompt, made non-intrusive: one toast with a Switch action per
//   window, plus a highlighted row in the panel.
import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useConnection } from './context';
import { storageKey } from './storage';
import type { UsageView } from './usage';
import { confirmAction, showToast } from '../components/feedback';
import { suggestSwitch, switchSuggestionKey } from '../lib/account-switch';

export type Account = {
  id: string;
  name: string;
  // Usable right now. An expired login reports false (and `login: 'expired'`).
  loggedIn: boolean;
  // 'ok' | 'expired' | 'none' (see classifyLogin in src/main/accounts-lib.js).
  login?: string;
  email?: string;
  plan?: string;
};
type AccountList = { activeId: string | null; accounts: Account[] };
type Conn = NonNullable<ReturnType<typeof useConnection>['conn']>;

// The desktop's built-in first account is stored as "Default" — same label it shows.
export function accountLabel(account: Account): string {
  return account.name || account.email || 'Account';
}

export function useAccounts(enabled: boolean, { withUsage = false } = {}) {
  const { conn, state } = useConnection();
  const [list, setList] = useState<AccountList | null>(null);
  const [usageById, setUsageById] = useState<Record<string, UsageView>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn || state !== 'ready') return;
    setLoading(true);
    setError(false);
    // The list comes back fast; per-account usage costs one API call per account
    // on the desktop, so it is a separate request the list never waits on.
    const listing = conn.req<AccountList>('accounts-list')
      .then((r) => setList(r))
      .catch(() => setError(true));
    if (withUsage) {
      conn.req<Record<string, UsageView>>('accounts-usage', undefined, { timeoutMs: 30000 })
        .then((r) => setUsageById(r ?? {}))
        .catch(() => {});
    }
    await listing;
    setLoading(false);
  }, [conn, state, withUsage]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  // Any window (or this phone) switching the account repaints the list.
  useEffect(() => {
    if (!conn || !enabled) return undefined;
    return conn.on('account-changed', ({ activeId }: { activeId: string }) => {
      setList((prev) => (prev ? { ...prev, activeId } : prev));
      refresh();
    });
  }, [conn, enabled, refresh]);

  const switchTo = useCallback(async (account: Account) => {
    if (!conn) return false;
    const switched = await confirmAndSwitch(conn, account);
    if (switched) setList((prev) => (prev ? { ...prev, activeId: account.id } : prev));
    return switched;
  }, [conn]);

  return {
    activeId: list?.activeId ?? null,
    accounts: list?.accounts ?? [],
    usageById,
    loading: loading && !list,
    error: error && !list,
    refresh,
    switchTo,
  };
}

// Same question the desktop asks before a switch, same consequence spelled out.
export async function confirmAndSwitch(conn: Conn, account: Account): Promise<boolean> {
  const ok = await confirmAction({
    title: `Switch to “${accountLabel(account)}” now?`,
    message: 'Open sessions in this desktop window move to the new account right away, without restarting — even mid-turn.',
    confirmLabel: 'Switch',
    destructive: false,
  });
  if (!ok) return false;
  try {
    const activeId = await conn.req<string>('accounts-set-active', account.id);
    if (activeId !== account.id) throw new Error('not switched');
    showToast({ message: `Switched to ${accountLabel(account)}`, tone: 'success' });
    return true;
  } catch {
    showToast({ message: `Couldn't switch to ${accountLabel(account)}`, tone: 'error' });
    return false;
  }
}

// ---- The 95% suggestion -----------------------------------------------------
//
// Every mounted header calls the hook, so the state is module-level: one lookup
// per 5-hour window however many headers are alive, and they all agree.

type Suggestion = { key: string; target: Account } | null;
let currentSuggestion: Suggestion = null;
const suggestionListeners = new Set<(s: Suggestion) => void>();
// The usage reset this phone last looked up targets for — the account list and the
// per-account usage are both costly on the desktop, so they're read once per window.
let checkedReset: string | null = null;
const KEY_TOASTED = storageKey('accountSwitchToasted');

function publishSuggestion(s: Suggestion) {
  currentSuggestion = s;
  suggestionListeners.forEach((fn) => fn(s));
}

async function lookUpSuggestion(conn: Conn, view: UsageView) {
  const list = await conn.req<AccountList>('accounts-list').catch(() => null);
  if (!list || !switchSuggestionKey(list.activeId, view)) return publishSuggestion(null);
  const usageById = await conn.req<Record<string, UsageView>>('accounts-usage', undefined, { timeoutMs: 30000 })
    .catch(() => ({}));
  const suggestion = suggestSwitch({ activeId: list.activeId, accounts: list.accounts, view, usageById });
  publishSuggestion(suggestion);
  if (suggestion) await toastOncePerWindow(conn, suggestion);
}

// "Not now" on the desktop holds until the window resets; here the equivalent is a
// toast that appears once per window and is simply allowed to fade.
async function toastOncePerWindow(conn: Conn, suggestion: NonNullable<Suggestion>) {
  const seen = await SecureStore.getItemAsync(KEY_TOASTED).catch(() => null);
  if (seen === suggestion.key) return;
  SecureStore.setItemAsync(KEY_TOASTED, suggestion.key).catch(() => {});
  showToast({
    message: `5-hour limit almost reached. Switch to ${accountLabel(suggestion.target)}?`,
    tone: 'info',
    actionLabel: 'Switch',
    onAction: () => {
      confirmAndSwitch(conn, suggestion.target).then((switched) => { if (switched) publishSuggestion(null); });
    },
  });
}

// The account worth switching to right now, or null. Drives the header ring's
// dot and the panel's highlighted row.
export function useSwitchSuggestion(view: UsageView): Suggestion {
  const { conn, state } = useConnection();
  const [suggestion, setSuggestion] = useState<Suggestion>(currentSuggestion);

  useEffect(() => {
    suggestionListeners.add(setSuggestion);
    return () => { suggestionListeners.delete(setSuggestion); };
  }, []);

  // The active account's own key isn't known without the account list, so the
  // cheap check — is the 5-hour window past the threshold at all — gates the lookup,
  // keyed on the window's reset so it runs once per window.
  const fiveHour = view?.windows?.find((w) => w.key === '5h');
  const nearLimit = !!switchSuggestionKey('active', view);
  const resetKey = nearLimit ? String(fiveHour?.resetAt ?? '') : null;

  useEffect(() => {
    if (!conn || state !== 'ready') return;
    if (!resetKey) {
      if (currentSuggestion) publishSuggestion(null);
      checkedReset = null;
      return;
    }
    if (checkedReset === resetKey) return;
    checkedReset = resetKey;
    // `view` is read at lookup time only; the reset key is what decides a re-check.
    lookUpSuggestion(conn, view);
  }, [conn, state, resetKey]);

  // A switch from anywhere settles the suggestion. `checkedReset` deliberately
  // stays put: until the next usage reading lands, `view` is still the *old*
  // account's near-full window, and re-checking against it would suggest switching
  // away from the account just switched to. The new account's reading carries its
  // own reset time, which is what triggers a fresh look.
  useEffect(() => {
    if (!conn) return undefined;
    return conn.on('account-changed', () => publishSuggestion(null));
  }, [conn]);

  return suggestion;
}
