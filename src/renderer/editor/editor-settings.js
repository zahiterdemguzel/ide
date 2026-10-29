// User-facing editor preferences (Settings → Editor) and how each maps onto
// Monaco's options. Persistence is one JSON blob in localStorage; the mapping is
// pure so it's unit-tested without Monaco or a DOM.

export const STORE_KEY = 'ide.editorSettings';

export const EDITOR_DEFAULTS = {
  fontSize: 13,
  fontFamily: '',          // '' → the platform's default monospace stack below
  fontLigatures: true,
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true, // follow the file's own indentation when it has one
  wordWrap: false,
  minimap: true,
  stickyScroll: true,
  lineNumbers: 'on',       // 'on' | 'relative' | 'off'
  renderWhitespace: 'selection', // 'none' | 'selection' | 'boundary' | 'all'
  formatOnSave: false,
  formatOnPaste: false,
  autoSave: 'off',         // 'off' | 'afterDelay' | 'onFocusChange'
  autoSaveDelay: 1000,
  inlineCompletions: false, // AI ghost-text suggestions; off by default since every suggestion spends tokens
  inlineBlame: true,       // "author, 3 days ago · summary" after the caret line
  bracketPairColorization: true,
  cursorBlinking: 'smooth',
  smoothScrolling: true,
};

export const DEFAULT_FONT_STACK = "'JetBrains Mono', 'SF Mono', Menlo, 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace";

const CHOICES = {
  lineNumbers: ['on', 'relative', 'off'],
  renderWhitespace: ['none', 'selection', 'boundary', 'all'],
  autoSave: ['off', 'afterDelay', 'onFocusChange'],
};

// Merge stored values over the defaults, dropping anything of the wrong type or
// outside its allowed set (an old/hand-edited blob must never break the editor).
export function normalizeSettings(raw) {
  const out = { ...EDITOR_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, def] of Object.entries(EDITOR_DEFAULTS)) {
    const value = raw[key];
    if (typeof value !== typeof def) continue;
    if (CHOICES[key] && !CHOICES[key].includes(value)) continue;
    out[key] = value;
  }
  out.fontSize = Math.min(40, Math.max(8, Math.round(out.fontSize)));
  out.tabSize = Math.min(16, Math.max(1, Math.round(out.tabSize)));
  out.autoSaveDelay = Math.min(60000, Math.max(200, Math.round(out.autoSaveDelay)));
  return out;
}

// Options for monaco.editor.create / editor.updateOptions.
export function toMonacoOptions(s) {
  return {
    fontSize: s.fontSize,
    fontFamily: s.fontFamily || DEFAULT_FONT_STACK,
    fontLigatures: s.fontLigatures,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap, renderCharacters: false, showSlider: 'mouseover' },
    stickyScroll: { enabled: s.stickyScroll },
    lineNumbers: s.lineNumbers,
    renderWhitespace: s.renderWhitespace,
    formatOnPaste: s.formatOnPaste,
    bracketPairColorization: { enabled: s.bracketPairColorization },
    guides: { bracketPairs: s.bracketPairColorization ? 'active' : false, indentation: true, highlightActiveIndentation: true },
    cursorBlinking: s.cursorBlinking,
    cursorSmoothCaretAnimation: s.smoothScrolling ? 'on' : 'off',
    smoothScrolling: s.smoothScrolling,
    inlineSuggest: { enabled: s.inlineCompletions, mode: 'subwordSmart' },
  };
}

// Options applied per model (tab size / spaces), unless detectIndentation found
// the file's own style.
export function toModelOptions(s) {
  return { tabSize: s.tabSize, insertSpaces: s.insertSpaces };
}

export function loadSettings(storage) {
  try { return normalizeSettings(JSON.parse(storage.getItem(STORE_KEY) || 'null')); }
  catch { return { ...EDITOR_DEFAULTS }; }
}

export function saveSettings(storage, settings) {
  try { storage.setItem(STORE_KEY, JSON.stringify(normalizeSettings(settings))); } catch { /* storage full/blocked */ }
}
