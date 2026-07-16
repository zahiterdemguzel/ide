// The one place a dialog's layout is built. Every modal that asks the user
// something or reports an error goes through openDialog() — confirm, prompt,
// warning, error and the pickString list are all specs handed to this file, not
// markup of their own. Nothing else may hand-roll dialog chrome: the four
// hand-rolled copies this replaced had already drifted apart on padding, title
// size and button metrics. The matching styles are the .dlg family in
// src/styles/base.css; see .claude/memory/desktop-dialogs.md.
//
// The <dialog> is created per call and removed on close rather than parked in
// index.html, so the layout lives here instead of being split across two files.
// It's a native dialog (not a div) because showModal() brings focus trapping,
// Esc and ::backdrop with it.

// One dialog per key may be open (`singleton`): a burst of errors replaces the
// open one instead of stacking a wall of dialogs.
const openByKey = new Map();

// A spec is:
//   title, tone ('error' reddens the title), body, mono (monospace body, for
//   command output), label, input ({ placeholder, value, error }), options
//   ([{ label, value }], the pickString list), buttons, cancelValue, singleton.
// A button is:
//   { label, value, variant: 'primary'|'secondary'|'danger', keepOpen, onClick }
//   `value` may be a function, called with the input's trimmed text.
// Resolves to the chosen button's value, or cancelValue on Esc/backdrop.
export function openDialog(spec = {}) {
  const {
    title = '', tone, body = '', mono = false, label = '',
    input, options, buttons = [], cancelValue = null, singleton,
  } = spec;

  if (singleton) openByKey.get(singleton)?.close();

  const dlg = document.createElement('dialog');
  dlg.className = tone === 'error' ? 'dlg is-error' : 'dlg';

  const titleEl = document.createElement('h3');
  titleEl.className = 'dlg-title';
  titleEl.textContent = title;
  dlg.append(titleEl);

  if (body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = mono ? 'dlg-body is-mono' : 'dlg-body';
    bodyEl.textContent = body;
    dlg.append(bodyEl);
  }
  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'dlg-label';
    labelEl.textContent = label;
    dlg.append(labelEl);
  }

  let inputEl = null;
  if (input) {
    inputEl = document.createElement('input');
    inputEl.className = 'dlg-input';
    inputEl.type = 'text';
    inputEl.placeholder = input.placeholder || '';
    inputEl.value = input.value || '';
    const errEl = document.createElement('div');
    errEl.className = 'dlg-error';
    errEl.textContent = input.error || '';
    dlg.append(inputEl, errEl);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (singleton) openByKey.delete(singleton);
      dlg.onclose = null;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const valueOf = (v) => (typeof v === 'function' ? v(inputEl ? inputEl.value.trim() : '') : v);

    for (const opt of options || []) {
      const btn = document.createElement('button');
      btn.className = 'dlg-option';
      btn.textContent = opt.label;
      btn.onclick = () => finish(opt.value);
      dlg.append(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    let primary = null;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = `dlg-btn dlg-btn-${b.variant || 'secondary'}`;
      btn.textContent = b.label;
      btn.onclick = () => {
        b.onClick?.(btn);
        if (!b.keepOpen) finish(valueOf(b.value));
      };
      if (b.variant === 'primary' || b.variant === 'danger') primary = primary || btn;
      actions.append(btn);
    }
    if (buttons.length) dlg.append(actions);

    // Enter commits the primary action from a text field, where a newline has
    // nothing else to mean.
    if (inputEl && primary) {
      inputEl.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        primary.click();
      };
    }

    dlg.onclose = () => finish(cancelValue); // Esc, and the backdrop below
    dlg.onclick = (e) => { if (e.target === dlg) finish(cancelValue); };

    document.body.append(dlg);
    if (singleton) openByKey.set(singleton, dlg);
    dlg.showModal();
    inputEl?.focus();
    inputEl?.select();
  });
}
