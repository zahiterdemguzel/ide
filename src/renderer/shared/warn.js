import { t } from '../../i18n/index.js';
import { openDialog } from './dialog.js';

// A modal warning for non-fatal errors — a session failing to save/retrieve, or
// anything else we'd rather surface than crash on. OK dismisses it and Copy
// grabs the full text. Safe to call repeatedly: it's a singleton, so a burst of
// errors replaces the open dialog instead of stacking a pile of them.
export function showWarning(message, title) {
  const text = String(message == null ? '' : message).trim() || t('warn.unknown');
  return openDialog({
    title: title || t('warn.title'),
    tone: 'error',
    body: text,
    mono: true,
    singleton: 'warn',
    buttons: [
      {
        label: t('warn.copy'),
        variant: 'secondary',
        keepOpen: true, // the point is to copy *and* still read the text
        onClick: async (btn) => {
          try { await window.api.clipboardWrite(text); } catch { /* clipboard unavailable */ }
          btn.textContent = t('warn.copied');
        },
      },
      { label: t('warn.ok'), value: true, variant: 'primary' },
    ],
  });
}

// A failed operation the user can only acknowledge. `mono` is on by default
// because the usual message is a command's own stderr; pass false for prose we
// wrote ourselves.
export function showError(message, title, { mono = true } = {}) {
  return openDialog({
    title,
    tone: 'error',
    body: message,
    mono,
    singleton: 'error',
    buttons: [{ label: 'OK', value: true, variant: 'primary' }],
  });
}
