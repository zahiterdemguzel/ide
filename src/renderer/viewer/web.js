// --- inline web browser (toolbar button + Ctrl+clicked http/https links) ---
// A <webview> runs the page out-of-process, so the host CSP doesn't restrict it.
// It uses a `persist:browser` partition (set in index.html) so cookies and site
// data live on disk and survive restarts; the ⋮ menu's "Reset cookies" clears them.
//
// There is exactly one webview, reused for every open — opening the browser never
// spawns a second instance. The page stays **loaded in the background** when the
// overlay is hidden (e.g. on session switch): hideWeb() only hides the view, it
// does not unload the page. The only thing that tears the page down is the
// explicit two-click Terminate button (terminateWeb()), which destroys the live
// webview and its renderer process outright. The toolbar browser button lights
// up (`.active`) whenever a real page is loaded, so the user can tell the browser
// is alive in the background, and it toggles the overlay: clicking it while the
// browser is showing closes (hides) it without terminating. Peer overlays /
// session terminals are hidden by the center coordinator first; the close/
// terminate buttons are wired there too.
import { confirmDialog } from '../shared/confirm.js';
import { hideArmHint } from '../shared/arm-hint.js';

const webView = document.getElementById('web-view');
// Reassigned by terminateWeb(), which destroys the live webview and swaps in a
// fresh one — so this can't be `const`.
let webFrame = document.getElementById('web-frame');
const webUrlEl = document.getElementById('web-url');
const suggestEl = document.getElementById('web-suggest');
const menuBtn = document.getElementById('web-menu');
const menuEl = document.getElementById('web-menu-dropdown');
const browserBtn = document.getElementById('browser-btn');
const terminateBtn = document.getElementById('web-terminate');
const inspectBtn = document.getElementById('web-inspect');

const isBlank = (url) => !url || url === 'about:blank';
const isLoaded = () => !isBlank(webFrame.getAttribute('src'));

// The toolbar browser button is "active" (accent-coloured) whenever a real page
// is loaded in the background webview, so it doubles as a browser-alive indicator.
function setActive(on) { browserBtn.classList.toggle('active', on); }
const disarmTerminate = () => { terminateBtn.classList.remove('armed'); hideArmHint(); };

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
  if (inspecting) stopInspect();
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
// Use the computed style, not the inline one: the overlay starts hidden via a CSS
// rule (display:none in web.css), so before the first show/hide the inline
// style.display is '' — reading it directly would misreport the overlay as open.
export function isWebOpen() { return getComputedStyle(webView).display !== 'none'; }

// Shut the browser down completely — the only thing that resets it. Called by
// the two-click Terminate button (wired in the center coordinator). Navigating
// to about:blank would leave the webview's renderer process alive in the
// background (media kept playing, timers kept firing), so instead we destroy the
// live webview element — removing it from the DOM kills its process — and swap in
// a fresh blank one for the next open.
export function terminateWeb() {
  if (inspecting) stopInspect();
  const fresh = createFrame();
  webFrame.replaceWith(fresh);
  webFrame = fresh;
  webUrlEl.value = '';
  webUrlEl.title = '';
  setActive(false);
}

// Build a pristine webview matching index.html's (same id, blank page, and the
// persistent cookie partition) with the navigation listeners attached.
function createFrame() {
  const frame = document.createElement('webview');
  frame.id = 'web-frame';
  frame.setAttribute('src', 'about:blank');
  frame.setAttribute('partition', 'persist:browser');
  frame.addEventListener('did-navigate', onNav);
  frame.addEventListener('did-navigate-in-page', onNav);
  return frame;
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


// --- ⋮ menu (clean cookies control) ---

const hideMenu = () => { menuEl.style.display = 'none'; };
menuBtn.onclick = (e) => {
  e.stopPropagation();
  menuEl.style.display = menuEl.style.display === 'block' ? 'none' : 'block';
};
document.addEventListener('click', (e) => { if (!menuEl.contains(e.target) && e.target !== menuBtn) hideMenu(); });

document.getElementById('web-external').onclick = () => {
  hideMenu();
  window.api.openExternal(webUrlEl.value);
};

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

// --- inspect element (color-picker button) ---
//
// Lets the user pick any element in the guest page and copies a full report of it
// (page URL, XPath, selector, size, the key computed styles, and the trimmed
// outerHTML) to the clipboard. The picker has to run *inside* the guest process,
// so we inject it with `webFrame.executeJavaScript`: the injected IIFE returns a
// Promise that stays pending until the user clicks an element (or hits Escape /
// cancels), and `executeJavaScript` resolves the host-side await with whatever
// that Promise resolves to — a plain (structured-cloneable) data object. The
// guest also parks a `window.__ideInspectCancel` we can call to abort the pick
// from the host (re-clicking the button, or closing the overlay).

let inspecting = false;

// This function is never called here — it's stringified and run in the guest page.
function guestInspector() {
  return new Promise((resolve) => {
    const hl = document.createElement('div');
    Object.assign(hl.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box',
      background: 'rgba(74,140,255,0.22)', border: '1px solid rgba(74,140,255,0.95)', borderRadius: '2px',
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', whiteSpace: 'nowrap',
      font: '11px/1.5 Consolas, monospace', background: '#1e1e1e', color: '#fff',
      padding: '2px 6px', borderRadius: '3px', maxWidth: '90vw', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    document.documentElement.append(hl, label);
    document.body.style.cursor = 'crosshair';
    let current = null;

    const selector = (el) => {
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
      let s = el.tagName.toLowerCase();
      if (el.classList.length) s += '.' + Array.from(el.classList).join('.');
      return s;
    };
    const xpath = (el) => {
      if (el.id) return '//*[@id="' + el.id + '"]';
      const parts = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        let i = 1;
        for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.tagName === n.tagName) i++;
        }
        parts.unshift(n.tagName.toLowerCase() + '[' + i + ']');
      }
      return '/' + parts.join('/');
    };
    const collect = (el) => {
      const cs = getComputedStyle(el);
      const props = ['display', 'position', 'width', 'height', 'margin', 'padding', 'border',
        'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
        'text-align', 'box-shadow', 'border-radius', 'opacity', 'z-index', 'flex', 'grid-template-columns'];
      const styles = {};
      for (const p of props) {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') styles[p] = v;
      }
      const r = el.getBoundingClientRect();
      const MAX = 1500;
      let html = el.outerHTML || '';
      const trimmed = html.length > MAX;
      if (trimmed) html = html.slice(0, MAX) + '\n…';
      return {
        url: location.href, xpath: xpath(el), selector: selector(el), tag: el.tagName.toLowerCase(),
        id: el.id || '', className: typeof el.className === 'string' ? el.className : '',
        rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) },
        styles, html, trimmed,
      };
    };

    const onMove = (e) => {
      const el = e.target;
      if (!el || el === hl || el === label) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      label.textContent = selector(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      label.style.left = r.left + 'px';
      label.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 4) + 'px';
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      hl.remove(); label.remove();
      document.body.style.cursor = '';
      window.__ideInspectCancel = null;
    };
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const data = collect(current || e.target);
      cleanup();
      resolve(data);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); } };

    window.__ideInspectCancel = () => { cleanup(); resolve(null); };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}

function formatInspect(d) {
  const lines = [
    'Page URL: ' + (d.url || webUrlEl.value),
    'Selector: ' + d.selector,
    'XPath: ' + d.xpath,
    'Tag: ' + d.tag,
  ];
  if (d.id) lines.push('ID: ' + d.id);
  if (d.className) lines.push('Classes: ' + d.className);
  lines.push('Size: ' + d.rect.w + ' × ' + d.rect.h + ' px  @ (' + d.rect.x + ', ' + d.rect.y + ')');
  const keys = Object.keys(d.styles);
  if (keys.length) {
    lines.push('', 'Computed styles:');
    for (const k of keys) lines.push('  ' + k + ': ' + d.styles[k]);
  }
  lines.push('', 'HTML' + (d.trimmed ? ' (trimmed):' : ':'), d.html);
  return lines.join('\n');
}

function copyText(text) {
  if (window.api && window.api.clipboardWrite) window.api.clipboardWrite(text);
  else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function flashInspect() {
  inspectBtn.classList.add('copied');
  setTimeout(() => inspectBtn.classList.remove('copied'), 900);
}

function stopInspect() {
  try { webFrame.executeJavaScript('window.__ideInspectCancel && window.__ideInspectCancel()'); } catch {}
}

async function startInspect() {
  if (!isLoaded()) return;
  if (inspecting) { stopInspect(); return; }
  inspecting = true;
  inspectBtn.classList.add('armed');
  try {
    const data = await webFrame.executeJavaScript('(' + guestInspector.toString() + ')()', true);
    if (data) { copyText(formatInspect(data)); flashInspect(); }
  } catch {}
  inspecting = false;
  inspectBtn.classList.remove('armed');
}

inspectBtn.onclick = startInspect;
