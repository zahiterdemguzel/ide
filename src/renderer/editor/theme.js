// Bridges the app's CSS-variable themes (base.css / themes.css) into a Monaco
// theme. Monaco paints with its own colour table and can't read CSS variables,
// so we resolve the active palette to hex and define an 'ide' theme from it:
// editor chrome (background, gutter, selection, widgets) follows the app, while
// token colours come from the closest built-in base (vs / vs-dark / hc-black).
// A MutationObserver on <html data-theme> re-defines it when the user switches.

const THEME_NAME = 'ide';

// Resolve any CSS colour (var(), rgb(), named) to #rrggbb[aa], which is the
// only form Monaco's theme table accepts.
function resolveColor(value) {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/.exec(rgb);
  if (!m) return null;
  const hex = (n) => Math.round(Number(n)).toString(16).padStart(2, '0');
  const alpha = m[4] !== undefined && Number(m[4]) < 1 ? hex(Number(m[4]) * 255) : '';
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}${alpha}`;
}

function cssVar(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? resolveColor(raw) : null;
}

// Perceived lightness of a #rrggbb colour, 0..1.
function lightness(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function withAlpha(hex, alpha) {
  return hex.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

// Colours for language-server semantic tokens (Monaco matches a token's type
// against these rule names), taken from VS Code's Dark+ / Light+ themes.
const SEMANTIC_DARK = {
  namespace: '4ec9b0', class: '4ec9b0', struct: '4ec9b0', type: '4ec9b0', interface: '4ec9b0',
  enum: '4ec9b0', typeParameter: '4ec9b0', function: 'dcdcaa', method: 'dcdcaa', macro: 'dcdcaa',
  variable: '9cdcfe', parameter: '9cdcfe', property: '9cdcfe', enumMember: '4fc1ff', decorator: 'dcdcaa',
};
const SEMANTIC_LIGHT = {
  namespace: '267f99', class: '267f99', struct: '267f99', type: '267f99', interface: '267f99',
  enum: '267f99', typeParameter: '267f99', function: '795e26', method: '795e26', macro: '795e26',
  variable: '001080', parameter: '001080', property: '001080', enumMember: '0070c1', decorator: '795e26',
};

function semanticRules(base) {
  if (base === 'hc-black') return [];
  const palette = base === 'vs' ? SEMANTIC_LIGHT : SEMANTIC_DARK;
  return Object.entries(palette).map(([token, foreground]) => ({ token, foreground }));
}

function buildTheme() {
  const bg = cssVar('--bg') || '#1e1e1e';
  const bg2 = cssVar('--bg-2') || bg;
  const bg3 = cssVar('--bg-3') || bg2;
  const border = cssVar('--border') || '#333333';
  const fg = cssVar('--fg') || '#cccccc';
  const fgDim = cssVar('--fg-dim') || '#858585';
  const accent = cssVar('--accent') || '#0e639c';
  const sel = cssVar('--term-sel') || cssVar('--list-sel') || '#264f78';
  const listSel = cssVar('--list-sel') || sel;
  const green = cssVar('--green') || '#3fb950';
  const red = cssVar('--red') || '#f85149';
  const yellow = cssVar('--yellow') || '#d29922';
  const theme = document.documentElement.dataset.theme || 'dark';
  const base = theme === 'high-contrast' ? 'hc-black' : (lightness(bg) > 0.5 ? 'vs' : 'vs-dark');

  return {
    base,
    inherit: true,
    rules: semanticRules(base),
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorGutter.background': bg,
      'editorLineNumber.foreground': fgDim,
      'editorLineNumber.activeForeground': fg,
      'editor.lineHighlightBackground': withAlpha(bg3, 0.6),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': sel,
      'editor.inactiveSelectionBackground': withAlpha(sel, 0.5),
      'editorCursor.foreground': cssVar('--term-cursor') || fg,
      'editorIndentGuide.background1': withAlpha(border, 0.8),
      'editorIndentGuide.activeBackground1': fgDim,
      'editorWhitespace.foreground': withAlpha(fgDim, 0.4),
      'editorWidget.background': bg2,
      'editorWidget.border': border,
      'editorSuggestWidget.background': bg2,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': listSel,
      'editorHoverWidget.background': bg2,
      'editorHoverWidget.border': border,
      'peekView.border': accent,
      'peekViewEditor.background': bg2,
      'peekViewResult.background': bg3,
      'peekViewTitle.background': bg3,
      'input.background': bg,
      'input.border': border,
      'focusBorder': accent,
      'list.activeSelectionBackground': listSel,
      'list.hoverBackground': withAlpha(listSel, 0.5),
      'minimap.background': bg,
      'scrollbarSlider.background': withAlpha(fgDim, 0.25),
      'scrollbarSlider.hoverBackground': withAlpha(fgDim, 0.4),
      'scrollbarSlider.activeBackground': withAlpha(fgDim, 0.55),
      'editorGutter.addedBackground': green,
      'editorGutter.modifiedBackground': accent,
      'editorGutter.deletedBackground': red,
      'minimapGutter.addedBackground': green,
      'minimapGutter.modifiedBackground': accent,
      'minimapGutter.deletedBackground': red,
      'editorError.foreground': red,
      'editorWarning.foreground': yellow,
      'editorBracketMatch.background': withAlpha(accent, 0.25),
      'editorBracketMatch.border': withAlpha(accent, 0.8),
      'editorStickyScroll.background': bg,
      'editorStickyScrollHover.background': bg3,
      'diffEditor.insertedTextBackground': withAlpha(green, 0.2),
      'diffEditor.removedTextBackground': withAlpha(red, 0.2),
    },
  };
}

let observer = null;

// Define + apply the theme now, and keep it in sync with the app's theme.
export function installEditorTheme(monaco) {
  const apply = () => {
    monaco.editor.defineTheme(THEME_NAME, buildTheme());
    monaco.editor.setTheme(THEME_NAME);
  };
  apply();
  if (!observer) {
    observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return THEME_NAME;
}
