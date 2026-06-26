// --- inline web browser (toolbar button + Ctrl+clicked http/https links) ---
// A <webview> runs the page out-of-process, so the host CSP doesn't restrict it.
// It uses a `persist:browser` partition (set in index.html) so cookies and site
// data live on disk and survive restarts; the ⋮ menu's "Reset cookies" clears them.
//
// There is exactly one webview, reused for every open — opening the browser never
// spawns a second instance. The page stays **loaded in the background** when the
// overlay is hidden (e.g. on session switch): hideWeb() only hides the view, it
// does not unload the page. The only thing that unloads the page is the explicit
// two-click Terminate button (terminateWeb()). The toolbar browser button lights
// up (`.active`) whenever a real page is loaded, so the user can tell the browser
// is alive in the background, and it toggles the overlay: clicking it while the
// browser is showing closes (hides) it without terminating. Peer overlays /
// session terminals are hidden by the center coordinator first; the close/
// terminate buttons are wired there too.
import { confirmDialog } from '../shared/confirm.js';

const webView = document.getElementById('web-view');
const webFrame = document.getElementById('web-frame');
const webUrlEl = document.getElementById('web-url');
const suggestEl = document.getElementById('web-suggest');
const menuBtn = document.getElementById('web-menu');
const menuEl = document.getElementById('web-menu-dropdown');
const browserBtn = document.getElementById('browser-btn');
const terminateBtn = document.getElementById('web-terminate');

const isBlank = (url) => !url || url === 'about:blank';
const isLoaded = () => !isBlank(webFrame.getAttribute('src'));

// The toolbar browser button is "active" (accent-coloured) whenever a real page
// is loaded in the background webview, so it doubles as a browser-alive indicator.
function setActive(on) { browserBtn.classList.toggle('active', on); }
const disarmTerminate = () => terminateBtn.classList.remove('armed');

// Visited addresses, most-recent-first, persisted so the address bar can offer
// them as suggestions across restarts (the page cookies persist; this is just
// the URL list the bar shows).
const HISTORY_KEY = 'web.history';
const HISTORY_MAX = 30;
const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
let history = loadHistory();

function pushHistory(url) {
  if (!url || url === 'about:blank') return;
  history = [url, ...history.filter((u) => u !== url)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
}

// Turn whatever the user typed into a navigable URL: keep a real scheme as-is,
// otherwise default to https:// (so "example.com" works like a browser bar).
function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s;
  return 'https://' + s;
}

// Hide the overlay only — the page keeps running in the background webview so
// the browser persists across session switches. Unloading is the Terminate
// button's job alone (terminateWeb()).
export function hideWeb() {
  webView.style.display = 'none';
  hideSuggest();
  hideMenu();
  disarmTerminate();
}

// Navigate to a URL and reveal the overlay (terminal-link Ctrl+click).
export function showWeb(url) {
  webUrlEl.value = url;
  webUrlEl.title = url;
  webFrame.src = url;
  setActive(!isBlank(url));
  webView.style.display = 'flex';
}

// Reveal the overlay without navigating (toolbar browser button): the already
// loaded page is shown as-is; an empty browser just focuses the address bar.
export function openWeb() {
  webView.style.display = 'flex';
  if (!isLoaded()) setTimeout(() => webUrlEl.focus(), 0);
}

// Whether the overlay is currently visible (toolbar button toggles on this).
export function isWebOpen() { return webView.style.display !== 'none'; }

// Unload the page — the only thing that resets the browser. Called by the
// two-click Terminate button (wired in the center coordinator).
export function terminateWeb() {
  try { webFrame.src = 'about:blank'; } catch {}
  webUrlEl.value = '';
  webUrlEl.title = '';
  setActive(false);
}

// --- address bar ---

function navigateTo(input) {
  const url = normalizeUrl(input);
  if (!url) return;
  hideSuggest();
  webUrlEl.value = url;
  webUrlEl.title = url;
  webUrlEl.blur();
  webFrame.src = url;
  setActive(!isBlank(url));
}

function renderSuggest() {
  const q = webUrlEl.value.trim().toLowerCase();
  // Empty bar → the latest addresses; otherwise substring-match the history.
  const items = (q ? history.filter((u) => u.toLowerCase().includes(q)) : history).slice(0, 10);
  if (!items.length) { hideSuggest(); return; }
  suggestEl.innerHTML = '';
  for (const u of items) {
    const li = document.createElement('li');
    li.textContent = u;
    li.title = u;
    // mousedown (not click) so it fires before the input's blur hides the list.
    li.addEventListener('mousedown', (e) => { e.preventDefault(); navigateTo(u); });
    suggestEl.appendChild(li);
  }
  suggestEl.style.display = 'block';
}

const hideSuggest = () => { suggestEl.style.display = 'none'; };

webUrlEl.addEventListener('focus', renderSuggest);
webUrlEl.addEventListener('input', renderSuggest);
webUrlEl.addEventListener('blur', () => setTimeout(hideSuggest, 100));
webUrlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigateTo(webUrlEl.value); }
  else if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); webUrlEl.blur(); }
});

// Keep the address bar in sync as the guest page navigates (but don't clobber
// what the user is mid-typing), and record the address for future suggestions.
function onNav(e) {
  if (document.activeElement !== webUrlEl) { webUrlEl.value = e.url; }
  webUrlEl.title = e.url;
  setActive(!isBlank(e.url));
  pushHistory(e.url);
}
webFrame.addEventListener('did-navigate', onNav);
webFrame.addEventListener('did-navigate-in-page', onNav);

document.getElementById('web-back').onclick = () => { try { if (webFrame.canGoBack()) webFrame.goBack(); } catch {} };
document.getElementById('web-fwd').onclick = () => { try { if (webFrame.canGoForward()) webFrame.goForward(); } catch {} };
document.getElementById('web-reload').onclick = () => { try { webFrame.reload(); } catch {} };
document.getElementById('web-external').onclick = () => window.api.openExternal(webUrlEl.value);

// --- ⋮ menu (clean cookies control) ---

const hideMenu = () => { menuEl.style.display = 'none'; };
menuBtn.onclick = (e) => {
  e.stopPropagation();
  menuEl.style.display = menuEl.style.display === 'block' ? 'none' : 'block';
};
document.addEventListener('click', (e) => { if (!menuEl.contains(e.target) && e.target !== menuBtn) hideMenu(); });

document.getElementById('web-reset-cookies').onclick = async () => {
  hideMenu();
  const ok = await confirmDialog({
    title: 'Reset cookies',
    message: 'Clear all saved cookies for the inline browser? You will be signed out of sites.',
    ok: 'Reset',
    danger: true,
  });
  if (!ok) return;
  await window.api.clearWebData();
  try { webFrame.reload(); } catch {}
};
