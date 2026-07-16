import { openDialog } from './dialog.js';

// A modal text prompt. Resolves to the trimmed input, or null if the user
// cancels (Cancel button, backdrop click, or Escape). Enter confirms.
export function promptText({ title, label, placeholder = '', value = '', error = '', ok = 'Create' } = {}) {
  return openDialog({
    title,
    label,
    input: { placeholder, value, error },
    cancelValue: null,
    buttons: [
      { label: 'Cancel', value: null, variant: 'secondary' },
      // Empty input reads as "no name given", i.e. the same as cancelling.
      { label: ok, value: (text) => text || null, variant: 'primary' },
    ],
  });
}

// A modal option list (pickString run-config inputs): one row per option, which
// may be a plain string or { label, value }. Resolves to the picked value, or
// null if cancelled. `def` marks the default option.
export function pickOption({ title, label, options = [], def } = {}) {
  return openDialog({
    title,
    label,
    cancelValue: null,
    options: options.map((opt) => {
      const value = typeof opt === 'object' && opt !== null ? opt.value : opt;
      const text = typeof opt === 'object' && opt !== null ? (opt.label || opt.value) : opt;
      return { label: text + (value === def ? ' (default)' : ''), value };
    }),
    buttons: [{ label: 'Cancel', value: null, variant: 'secondary' }],
  });
}
