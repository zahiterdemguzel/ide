// --- inline web browser (Ctrl+clicked http/https links) ---
// A <webview> runs the page out-of-process, so the host CSP doesn't restrict it.
// Peer overlays / session terminals are hidden by the center coordinator first;
// the close button is wired there too (shared with the diff/asset overlays).
const webView = document.getElementById('web-view');
const webFrame = document.getElementById('web-frame');
const webUrlEl = document.getElementById('web-url');

export function hideWeb() { webView.style.display = 'none'; webFrame.src = 'about:blank'; }

export function showWeb(url) {
  webUrlEl.textContent = url;
  webUrlEl.title = url;
  webFrame.src = url;
  webView.style.display = 'flex';
}

// Keep the address bar in sync as the guest page navigates.
const syncWebUrl = (e) => { webUrlEl.textContent = e.url; webUrlEl.title = e.url; };
webFrame.addEventListener('did-navigate', syncWebUrl);
webFrame.addEventListener('did-navigate-in-page', syncWebUrl);
document.getElementById('web-back').onclick = () => { try { if (webFrame.canGoBack()) webFrame.goBack(); } catch {} };
document.getElementById('web-fwd').onclick = () => { try { if (webFrame.canGoForward()) webFrame.goForward(); } catch {} };
document.getElementById('web-reload').onclick = () => { try { webFrame.reload(); } catch {} };
document.getElementById('web-external').onclick = () => window.api.openExternal(webUrlEl.textContent);
