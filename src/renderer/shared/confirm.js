import { openDialog } from './dialog.js';

// Modal confirm. Resolves true on OK, false on Cancel / Esc / backdrop.
// `danger: true` paints the OK button red for destructive acts.
export function confirmDialog({ title, message, ok = 'OK', danger = false } = {}) {
  return openDialog({
    title,
    body: message,
    cancelValue: false,
    buttons: [
      { label: 'Cancel', value: false, variant: 'secondary' },
      { label: ok, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
}

// A one-button notice — a failure the user can only acknowledge.
export function noticeDialog({ title, message, ok = 'OK' } = {}) {
  return openDialog({
    title,
    body: message,
    tone: 'error',
    buttons: [{ label: ok, value: true, variant: 'primary' }],
  });
}
