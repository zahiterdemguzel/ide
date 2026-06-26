// --- inline web browser (Ctrl+clicked http/https links) ---
// A <webview> runs the page out-of-process, so the host CSP doesn't restrict it.
// It uses a `persist:browser` partition (set in index.html) so cookies and site
// data live on disk and survive restarts; the ⋮ menu's "Reset cookies" clears them.
// Peer overlays / session terminals are hidden by the center coordinator first;
// the close button is wired there too (shared with the diff/asset overlays).
import { confirmDialog } from '../shared/confirm.js';

const webView = document.getElementById('web-view');
const webFrame = document.getElementById('web-frame');
const webUrlEl = document.getElementById('web-url');
const suggestEl = document.getElementById('web-suggest');
const menuBtn = document.getElementById('web-menu');
const menuEl = document.getElementById('web-menu-dropdown');

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

export function hideWeb() {
  webView.style.display = 'none';
  hideSuggest();
  hideMenu();
  // Only unload a real page. Re-navigating an already-blank webview to
  // about:blank makes Electron abort the duplicate navigation and log a noisy
  // ERR_ABORTED — which fires on every session switch, since hideAllOverlays()
  // calls this even when no page was ever opened.
  if (webFrame.src && webFrame.src !== 'about:blank') webFrame.src = 'about:blank';
}

export function showWeb(url) {
  webUrlEl.value = url;
  webUrlEl.title = url;
  webFrame.src = url;
  webView.style.display = 'flex';
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
