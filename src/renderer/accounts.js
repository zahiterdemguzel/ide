import { t } from '../i18n/index.js';
import { openDialog } from './shared/dialog.js';
import { promptText } from './shared/prompt.js';
import { confirmDialog } from './shared/confirm.js';
import {
  Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme, attachRenderer,
} from './shared/terminal.js';
import { registerTerminalLinks } from './terminal-links.js';
import {
  fiveHourUtilization, switchPromptKey, rankSwitchTargets, usageLevel, accountInitials, reloginPromptKey,
} from './shared/account-switch.js';

// --- toolbar account switcher (multiple Claude accounts) ---
// A pill left of the usage meter names the active Claude account; its menu lists
// every account with its 5-hour usage, switches with one click, and adds or signs
// in accounts. Each account is its own Claude Code config folder in main (see
// src/main/accounts.js), so switching never signs anyone out. When the active
// account crosses 95% of its 5-hour window, the user is asked whether to switch.

const switcher = document.getElementById('account-switcher');
const button = document.getElementById('account-btn');
const avatar = document.getElementById('account-avatar');
const nameLabel = document.getElementById('account-name');
const menu = document.getElementById('account-menu');

let state = { activeId: 'default', accounts: [] };
let firstLoad = Promise.resolve(); // settles once the account list has been read
let usageById = {};
const LOGIN_POLL_MS = 5 * 60 * 1000;

const PROMPTED_KEY = 'ide.accountSwitchPrompted';
// Questions already asked — a switch per account + 5-hour window, a re-login per
// account + login — so "Not now" sticks until the situation changes, across restarts.
const prompted = new Set(readPrompted());
function readPrompted() {
  try { return JSON.parse(localStorage.getItem(PROMPTED_KEY)) || []; } catch { return []; }
}
function rememberPrompted(key) {
  prompted.add(key);
  try { localStorage.setItem(PROMPTED_KEY, JSON.stringify([...prompted].slice(-20))); } catch {}
}

function displayName(account) {
  return account.id === 'default' && account.name === 'Default' ? t('accounts.default') : account.name;
}

function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeId) || state.accounts[0] || null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One account as a row: avatar, name over email, and a mini 5-hour usage bar.
// Shared by the toolbar menu and the switch prompt, so both read the same.
function accountRow(account, utilization, { active = false } = {}) {
  const row = el('div', 'acct-row');
  if (active) row.classList.add('is-active');
  const badge = el('span', 'acct-avatar', accountInitials(displayName(account)));
  const text = el('span', 'acct-text');
  text.append(el('span', 'acct-row-name', displayName(account)));
  const expired = account.login === 'expired';
  const detail = account.loggedIn ? (account.email || account.orgName || '')
    : expired ? t('accounts.loginExpired') : t('accounts.signedOut');
  const sub = el('span', 'acct-row-sub', detail);
  if (expired) sub.classList.add('is-error');
  else if (!account.loggedIn) sub.classList.add('is-warn');
  text.append(sub);
  row.append(badge, text);
  if (utilization !== null && utilization !== undefined) {
    const meter = el('span', 'acct-usage');
    const bar = el('span', 'acct-usage-bar');
    const fill = el('span', 'acct-usage-fill');
    fill.style.width = `${Math.round(utilization * 100)}%`;
    fill.dataset.level = usageLevel(utilization);
    bar.append(fill);
    meter.append(bar, el('span', 'acct-usage-pct', `${Math.round(utilization * 100)}%`));
    meter.title = `${t('usage.session')}: ${Math.round(utilization * 100)}% ${t('usage.used')}`;
    row.append(meter);
  }
  return row;
}

function renderButton() {
  const account = activeAccount();
  switcher.hidden = !account;
  if (!account) return;
  avatar.textContent = accountInitials(displayName(account));
  nameLabel.textContent = displayName(account);
  // The built-in account's name is a UI string; tag it so a language switch re-translates it.
  if (displayName(account) !== account.name) nameLabel.dataset.i18n = 'accounts.default';
  else delete nameLabel.dataset.i18n;
  const expired = account.login === 'expired';
  switcher.classList.toggle('is-expired', expired);
  button.title = expired ? t('accounts.loginExpiredTitle').replace('{name}', displayName(account))
    : account.email ? t('accounts.buttonTitleEmail').replace('{email}', account.email)
      : t('accounts.buttonTitle');
}

// `recheck` asks main to re-test the logins now instead of using its few-minute cache.
async function refreshAccounts({ recheck = false } = {}) {
  try { state = await window.api.listAccounts({ recheck }); } catch { return; }
  renderButton();
  if (!menu.hidden) renderMenu();
  askToRenewExpiredLogin();
}

// --- menu ---

function iconButton(svgPath, title, onClick) {
  const b = el('button', 'acct-icon-btn');
  b.type = 'button';
  b.title = title;
  b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

const ICON_SIGN_IN = '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>';
const ICON_RENAME = '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>';
const ICON_REMOVE = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';

function renderMenu() {
  menu.replaceChildren();
  menu.append(el('div', 'acct-menu-head', t('accounts.menuTitle')));
  for (const account of state.accounts) {
    const active = account.id === state.activeId;
    const row = accountRow(account, fiveHourUtilization(usageById[account.id]), { active });
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(active));
    row.tabIndex = 0;
    // An expired login gets its one-click renew right in the row, always visible.
    if (account.login === 'expired') {
      const renew = el('button', 'acct-renew', t('accounts.renew'));
      renew.type = 'button';
      renew.title = t('accounts.renewTitle');
      renew.addEventListener('click', (e) => { e.stopPropagation(); signIn(account); });
      row.append(renew);
    }
    const actions = el('span', 'acct-actions');
    actions.append(iconButton(ICON_SIGN_IN, t('accounts.signIn'), () => signIn(account)));
    actions.append(iconButton(ICON_RENAME, t('accounts.rename'), () => rename(account)));
    if (account.id !== 'default') actions.append(iconButton(ICON_REMOVE, t('accounts.remove'), () => remove(account)));
    row.append(actions);
    const pick = () => (account.loggedIn ? switchTo(account.id) : signIn(account));
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    menu.append(row);
  }
  const add = el('button', 'acct-add');
  add.type = 'button';
  add.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  add.append(el('span', '', t('accounts.add')));
  add.addEventListener('click', () => { closeMenu(); addAccount(); });
  menu.append(el('div', 'acct-menu-sep'), add);
}

function openMenu() {
  renderMenu();
  // Fixed, anchored under the button's right edge: the toolbar clips overflow, so
  // an absolutely positioned menu inside it would be cut off.
  const anchor = button.getBoundingClientRect();
  menu.style.top = `${anchor.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => menu.classList.add('open'));
  // Statuses and usage are fetched on open (one tiny call per account), then the
  // rows repaint in place.
  refreshAccounts();
  window.api.accountsUsage().then((u) => { usageById = u || {}; if (!menu.hidden) renderMenu(); }).catch(() => {});
}

function closeMenu() {
  menu.classList.remove('open');
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

// --- actions ---

// Main moves the open sessions over and pushes `account-changed`, which repaints
// the button and refreshes the usage meter (see initAccounts).
async function switchTo(id) {
  closeMenu();
  if (id === state.activeId) return;
  await window.api.setActiveAccount(id);
}

async function addAccount() {
  const name = await promptText({
    title: t('accounts.addTitle'), label: t('accounts.nameLabel'),
    placeholder: t('accounts.namePlaceholder'), ok: t('accounts.addOk'),
  });
  if (!name) return;
  const account = await window.api.addAccount(name);
  await refreshAccounts();
  const added = state.accounts.find((a) => a.id === account.id) || account;
  await signIn(added);
}

async function rename(account) {
  closeMenu();
  const name = await promptText({
    title: t('accounts.renameTitle'), label: t('accounts.nameLabel'),
    value: displayName(account), ok: t('accounts.renameOk'),
  });
  if (!name) return;
  state = await window.api.renameAccount(account.id, name);
  renderButton();
}

async function remove(account) {
  closeMenu();
  const ok = await confirmDialog({
    title: t('accounts.removeTitle').replace('{name}', displayName(account)),
    message: t('accounts.removeBody'),
    ok: t('accounts.remove'), danger: true,
  });
  if (!ok) return;
  state = await window.api.removeAccount(account.id);
  renderButton();
}

// The sign-in dialog's embedded terminal. One at a time; the term-data/term-exit
// listeners are registered once (initAccounts) and route by its id.
const login = { termId: null, term: null, close: null };

// Sign an account in with `claude auth login` in a terminal embedded in a dialog.
// The command exits once the browser login completes; the dialog then closes on
// its own and, if the account isn't the active one, offers to switch to it.
async function signIn(account) {
  closeMenu();
  const command = await window.api.accountLoginCommand(account.id);
  if (!command) return;
  const host = el('div', 'acct-term');
  let renderer = null;

  await openDialog({
    title: t('accounts.signInTitle').replace('{name}', displayName(account)),
    body: t('accounts.signInBody'),
    content: host,
    buttons: [{ label: t('accounts.done'), value: true, variant: 'primary' }],
    onOpen: ({ dlg, close }) => {
      dlg.classList.add('is-wide');
      login.close = close;
      const term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
      login.term = term;
      trackTermTheme(term);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      renderer = attachRenderer(term);
      attachClipboard(term);
      registerTerminalLinks(term);
      term.onData((d) => { if (login.termId) window.api.termInput(login.termId, d); });
      requestAnimationFrame(async () => {
        try { fit.fit(); } catch { /* not laid out yet */ }
        const res = await window.api.termCreate({
          cols: term.cols || 80, rows: term.rows || 20, name: 'Claude login', kind: 'login', ...command,
        });
        login.termId = res && res.id;
        term.focus();
      });
    },
  });

  if (login.termId) window.api.termKill(login.termId);
  if (renderer) renderer.dispose();
  if (login.term) { untrackTermTheme(login.term); login.term.dispose(); }
  Object.assign(login, { termId: null, term: null, close: null });

  await refreshAccounts({ recheck: true });
  const signedIn = state.accounts.find((a) => a.id === account.id);
  if (signedIn && signedIn.loggedIn && signedIn.id !== state.activeId) {
    const go = await confirmDialog({
      title: t('accounts.switchNowTitle').replace('{name}', displayName(signedIn)),
      message: t('accounts.switchBody'),
      ok: t('accounts.switch'),
    });
    if (go) await switchTo(signedIn.id);
  }
}

// --- the 95% prompt ---

// One account question at a time: the switch prompt, the re-login prompt, or a sign-in.
let promptOpen = false;

async function offerSwitch(key) {
  if (promptOpen) return;
  promptOpen = true;
  rememberPrompted(key);
  try {
    await refreshAccounts();
    try { usageById = (await window.api.accountsUsage()) || {}; } catch {}
    const current = activeAccount();
    const pct = Math.round((fiveHourUtilization(usageById[current.id]) ?? 0.95) * 100);
    const targets = rankSwitchTargets(state.accounts, usageById, state.activeId).filter((r) => r.account.loggedIn);
    const title = t('accounts.limitTitle');
    const intro = t('accounts.limitBody').replace('{name}', displayName(current)).replace('{pct}', pct);

    if (!targets.length) {
      const add = await openDialog({
        title, body: `${intro}\n\n${t('accounts.limitNoOther')}`, singleton: 'account-switch',
        buttons: [
          { label: t('accounts.notNow'), value: false, variant: 'secondary' },
          { label: t('accounts.add'), value: true, variant: 'primary' },
        ],
        cancelValue: false,
      });
      if (add) await addAccount();
      return;
    }

    let chosen = targets[0].account.id;
    const list = el('div', 'acct-pick-list');
    list.setAttribute('role', 'radiogroup');
    const rows = targets.map(({ account, utilization }) => {
      const row = accountRow(account, utilization, { active: account.id === chosen });
      row.classList.add('is-choice');
      row.setAttribute('role', 'radio');
      row.addEventListener('click', () => {
        chosen = account.id;
        for (const r of rows) r.classList.toggle('is-active', r === row);
      });
      list.append(row);
      return row;
    });

    const pick = await openDialog({
      title, body: `${intro}\n\n${t('accounts.switchBody')}`, content: list, singleton: 'account-switch',
      buttons: [
        { label: t('accounts.notNow'), value: null, variant: 'secondary' },
        { label: t('accounts.switch'), value: () => chosen, variant: 'primary' },
      ],
      cancelValue: null,
    });
    if (pick) await switchTo(pick);
  } finally {
    promptOpen = false;
  }
  askToRenewExpiredLogin(); // held back while this prompt was open
}

// --- expired logins ---

// Asks once per expired login whether to sign in again (see reloginPromptKey).
async function askToRenewExpiredLogin() {
  if (promptOpen || login.termId) return;
  const account = state.accounts.find((a) => {
    const key = reloginPromptKey(a);
    return key && !prompted.has(key);
  });
  if (!account) return;
  promptOpen = true;
  rememberPrompted(reloginPromptKey(account));
  let renew = false;
  try {
    renew = await confirmDialog({
      title: t('accounts.reloginTitle').replace('{name}', displayName(account)),
      message: t('accounts.reloginBody'),
      ok: t('accounts.renew'),
    });
  } finally {
    promptOpen = false;
  }
  if (renew) await signIn(account);
  else askToRenewExpiredLogin(); // another account may be waiting to ask
}

// The usage meter going blank for an account that had readings is the first sign
// its login lapsed — re-test right away rather than waiting for the next check.
const RECHECK_AFTER_BLANK_MS = 2 * 60 * 1000;
let hadUsage = false;
let lastBlankRecheck = 0;
function recheckIfUsageWentBlank(view) {
  if (view) { hadUsage = true; return; }
  if (!hadUsage || Date.now() - lastBlankRecheck < RECHECK_AFTER_BLANK_MS) return;
  hadUsage = false;
  lastBlankRecheck = Date.now();
  refreshAccounts({ recheck: true });
}

// Called with every fresh usage reading of the active account (usage-meter.js).
// Waits for the first account list, so the reading is keyed to the right account.
async function onUsage(view) {
  await firstLoad;
  recheckIfUsageWentBlank(view);
  const key = switchPromptKey(state.activeId, view);
  if (key && !prompted.has(key)) offerSwitch(key);
}

export function initAccounts() {
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!menu.hidden) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
  window.addEventListener('usage-updated', (e) => onUsage(e.detail));
  // Main confirms every switch (ours, or another window's): repaint, and let the
  // usage meter re-read the new account's limits.
  window.api.onAccountChanged(async () => {
    await refreshAccounts();
    window.dispatchEvent(new CustomEvent('account-changed'));
  });
  window.api.onTermData(({ id, data }) => { if (id === login.termId && login.term) login.term.write(data); });
  window.api.onTermExit(({ id }) => {
    if (id !== login.termId) return;
    login.termId = null;
    login.close?.(true);
  });
  firstLoad = refreshAccounts();
  // Logins expire on their own clock, so look again now and then (main caches each
  // check for a few minutes, so this is cheap), but only while the app is in use.
  setInterval(() => { if (document.hasFocus()) refreshAccounts(); }, LOGIN_POLL_MS);
}
