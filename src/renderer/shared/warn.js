console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/warn.js'); // PERF-TEMP
import { t } from '../../i18n/index.js';

// A modal warning for non-fatal errors — a session failing to save/retrieve, or
// anything else we'd rather surface than crash on. The error text shows in red
// (styled via #warn-msg) with OK to dismiss and Copy to grab the full text. Safe
// to call repeatedly: while one is open the newest message just replaces it, so a
// burst of errors can't stack dialogs.
export function showWarning(message, title) {
  const dlg = document.getElementById('warn-dialog');
  const text = String(message == null ? '' : message).trim() || t('warn.unknown');
  document.getElementById('warn-title').textContent = title || t('warn.title');
  document.getElementById('warn-msg').textContent = text;

  const copyBtn = document.getElementById('warn-copy');
  const okBtn = document.getElementById('warn-ok');
  copyBtn.textContent = t('warn.copy');

  const close = () => { okBtn.onclick = null; copyBtn.onclick = null; dlg.onclose = null; dlg.close(); };
  okBtn.onclick = close;
  copyBtn.onclick = async () => {
    try { await window.api.clipboardWrite(text); } catch { /* clipboard unavailable */ }
    copyBtn.textContent = t('warn.copied');
  };
  dlg.onclose = () => { okBtn.onclick = null; copyBtn.onclick = null; }; // Esc / backdrop
  if (!dlg.open) dlg.showModal();
}
