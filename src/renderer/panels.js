console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval panels.js'); // PERF-TEMP
// Panel visibility toggles. Lets the user show/hide the Explorer, Git, and
// Terminal panels plus the Launch-config / Task buttons in the run toolbar.
// Choices persist to localStorage and apply instantly. The sessions list is
// deliberately *not* toggleable — it's the app's primary surface.
//
// Each toggle either flips a panel's `.is-hidden` class (Explorer/Git/Terminal)
// or filters what the toolbar renders (Launch/Tasks). Hiding a panel also hides
// its drag-gutter and lets the surviving sibling grow to fill the freed space.

const STORE = 'ide.panels';

// id → settings checkbox + i18n label key. The order here is the order shown in
// the settings dialog. `sessions` is intentionally absent.
export const PANELS = [
  { id: 'explorer', labelKey: 'settings.panel.explorer' },
  { id: 'git', labelKey: 'settings.panel.git' },
  { id: 'terminal', labelKey: 'settings.panel.terminal' },
  { id: 'launch', labelKey: 'settings.panel.launch' },
  { id: 'tasks', labelKey: 'settings.panel.tasks' },
  { id: 'browser', labelKey: 'settings.panel.browser' },
  { id: 'usage', labelKey: 'settings.panel.usage' },
];

const DEFAULTS = {
  explorer: true, git: true, terminal: true, launch: true, tasks: true, browser: true,
  usage: true,
};

let state = { ...DEFAULTS };
const listeners = [];

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    state = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    state = { ...DEFAULTS };
  }
}

function saveState() {
  localStorage.setItem(STORE, JSON.stringify(state));
}

export function isPanelEnabled(id) {
  return state[id] !== false;
}

// Other modules (the toolbar) re-render when toggles change.
export function onPanelsChanged(fn) {
  listeners.push(fn);
}

function showEl(el, visible) {
  if (el) el.classList.toggle('is-hidden', !visible);
}

export function applyPanels() {
  const explorer = isPanelEnabled('explorer');
  const git = isPanelEnabled('git');
  const terminal = isPanelEnabled('terminal');

  // Left sidebar: sessions list always; explorer (file tree) optional. When the
  // explorer is hidden, drop its gutter and let the sessions list fill the side.
  showEl(document.getElementById('files-pane'), explorer);
  showEl(document.getElementById('gutter-sess'), explorer);
  document.getElementById('sidebar').classList.toggle('no-explorer', !explorer);

  // Right aside holds the git pane (top) and the terminal console (bottom). The
  // aside and its column gutter only exist when at least one of them is shown.
  const gitAside = document.getElementById('git');
  const showAside = git || terminal;
  showEl(gitAside, showAside);
  showEl(document.getElementById('gutter-right'), showAside);
  showEl(document.getElementById('git-main'), git);
  showEl(document.getElementById('git-console'), terminal);
  // The console gutter only makes sense when both panes are present to resize.
  showEl(document.getElementById('gutter-console'), git && terminal);
  // With the git pane hidden, the console alone fills the aside.
  gitAside.classList.toggle('solo-console', terminal && !git);

  // Browser button in the top toolbar (settings gear stays put beside it).
  showEl(document.getElementById('browser-btn'), isPanelEnabled('browser'));

  for (const fn of listeners) fn();
  // A layout change can resize the terminals; let the resize handler reflow them.
  window.dispatchEvent(new Event('resize'));
}

export function initPanels() {
  loadState();
  for (const { id } of PANELS) {
    const box = document.getElementById(`settings-panel-${id}`);
    if (!box) continue;
    box.checked = isPanelEnabled(id);
    box.onchange = () => {
      state[id] = box.checked;
      saveState();
      applyPanels();
    };
  }
  applyPanels();
}
