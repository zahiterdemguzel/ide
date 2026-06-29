// Keyboard shortcut cheat sheet — a <dialog> (shell in index.html) listing the
// shortcuts that actually exist in the app, grouped by area. Opened by the help
// (?) button, the F1 / ? key, and a command-palette entry. The shortcut list is
// the single source of truth here; keep it in step with the real handlers.
import { applyTranslations, t } from '../../i18n/index.js';
import { resetOnboarding } from './state.js';
import { startTour } from './tour.js';

const onMac = navigator.platform.toLowerCase().includes('mac');
const MOD = onMac ? '⌘' : 'Ctrl';

// Each row's `keys` is an array of key tokens rendered as <kbd> chips. `{MOD}`
// expands to ⌘ or Ctrl per platform. labelKey is an i18n key.
const SECTIONS = [
  {
    titleKey: 'cheatsheet.navigation',
    rows: [
      { keys: ['{MOD}', 'P'], labelKey: 'cheatsheet.goToFile' },
      { keys: ['{MOD}', 'Shift', 'P'], labelKey: 'cheatsheet.commandPalette' },
      { keys: ['{MOD}', 'N'], labelKey: 'cheatsheet.newSession' },
      { keys: ['Shift', '↓'], labelKey: 'cheatsheet.nextSession' },
      { keys: ['Shift', '↑'], labelKey: 'cheatsheet.prevSession' },
      { keys: ['{MOD}', 'Click'], labelKey: 'cheatsheet.terminalLink' },
      { keys: ['Esc'], labelKey: 'cheatsheet.closeOverlay' },
    ],
  },
  {
    titleKey: 'cheatsheet.editing',
    rows: [
      { keys: ['{MOD}', 'S'], labelKey: 'cheatsheet.save' },
      { keys: ['{MOD}', 'F'], labelKey: 'cheatsheet.find' },
      { keys: ['Enter'], labelKey: 'cheatsheet.findNext' },
      { keys: ['Shift', 'Enter'], labelKey: 'cheatsheet.findPrev' },
      { keys: ['Alt', 'C'], labelKey: 'cheatsheet.matchCase' },
    ],
  },
  {
    titleKey: 'cheatsheet.spreadsheet',
    rows: [
      { keys: ['{MOD}', 'B'], labelKey: 'cheatsheet.bold' },
      { keys: ['{MOD}', 'I'], labelKey: 'cheatsheet.italic' },
      { keys: ['{MOD}', 'C'], labelKey: 'cheatsheet.copy' },
      { keys: ['{MOD}', 'V'], labelKey: 'cheatsheet.paste' },
    ],
  },
];

let built = false;

function buildBody(body) {
  body.replaceChildren();
  for (const section of SECTIONS) {
    const h = document.createElement('h4');
    h.className = 'cheatsheet-section';
    h.dataset.i18n = section.titleKey;
    h.textContent = t(section.titleKey);
    body.appendChild(h);

    for (const row of section.rows) {
      const r = document.createElement('div');
      r.className = 'cheatsheet-row';
      const keys = document.createElement('span');
      keys.className = 'cheatsheet-keys';
      for (const token of row.keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = token === '{MOD}' ? MOD : token;
        keys.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'cheatsheet-label';
      label.dataset.i18n = row.labelKey;
      label.textContent = t(row.labelKey);
      r.append(keys, label);
      body.appendChild(r);
    }
  }
}

export function openCheatSheet() {
  const dialog = document.getElementById('cheatsheet-dialog');
  const body = document.getElementById('cheatsheet-body');
  if (!dialog || !body) return;
  // Rebuild each open so a language switch re-localizes labels.
  buildBody(body);
  applyTranslations(dialog);
  dialog.showModal();
}

export function initCheatSheet() {
  if (built) return;
  built = true;
  const dialog = document.getElementById('cheatsheet-dialog');
  document.getElementById('cheatsheet-close')?.addEventListener('click', () => dialog.close());
  // Replay the guided tour from the cheat sheet footer.
  document.getElementById('cheatsheet-replay')?.addEventListener('click', () => {
    dialog.close();
    resetOnboarding();
    startTour();
  });
  document.getElementById('help-btn')?.addEventListener('click', openCheatSheet);

  // F1 anywhere, or "?" when not typing into a field, opens the cheat sheet.
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
      || document.activeElement?.isContentEditable;
    const open = dialog.open;
    if (e.key === 'F1' || (e.key === '?' && !typing && !open)) {
      e.preventDefault();
      if (open) dialog.close(); else openCheatSheet();
    }
  });
}
