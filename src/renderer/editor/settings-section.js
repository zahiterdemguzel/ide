// Settings → Editor: the rows are generated from this table so every preference
// in editor-settings.js has exactly one control, and labels go through i18n
// (data-i18n, so a language switch relabels them live).

import { t } from '../../i18n/index.js';
import { getEditorSettings, setEditorSettings } from '../viewer/file.js';

const FIELDS = [
  { key: 'fontSize', kind: 'number', min: 8, max: 40, labelKey: 'settings.editorFontSize' },
  { key: 'fontFamily', kind: 'text', labelKey: 'settings.editorFontFamily', placeholderKey: 'settings.editorFontFamilyDefault' },
  { key: 'tabSize', kind: 'number', min: 1, max: 16, labelKey: 'settings.editorTabSize' },
  { key: 'lineNumbers', kind: 'select', labelKey: 'settings.editorLineNumbers', options: ['on', 'relative', 'off'] },
  { key: 'renderWhitespace', kind: 'select', labelKey: 'settings.editorWhitespace', options: ['none', 'selection', 'boundary', 'all'] },
  { key: 'autoSave', kind: 'select', labelKey: 'settings.editorAutoSave', options: ['off', 'afterDelay', 'onFocusChange'] },
  { key: 'insertSpaces', kind: 'switch', labelKey: 'settings.editorInsertSpaces' },
  { key: 'detectIndentation', kind: 'switch', labelKey: 'settings.editorDetectIndent' },
  { key: 'wordWrap', kind: 'switch', labelKey: 'settings.editorWordWrap' },
  { key: 'minimap', kind: 'switch', labelKey: 'settings.editorMinimap' },
  { key: 'stickyScroll', kind: 'switch', labelKey: 'settings.editorStickyScroll' },
  { key: 'fontLigatures', kind: 'switch', labelKey: 'settings.editorLigatures' },
  { key: 'bracketPairColorization', kind: 'switch', labelKey: 'settings.editorBracketPairs' },
  { key: 'formatOnSave', kind: 'switch', labelKey: 'settings.editorFormatOnSave' },
  { key: 'formatOnPaste', kind: 'switch', labelKey: 'settings.editorFormatOnPaste' },
  { key: 'inlineBlame', kind: 'switch', labelKey: 'settings.editorInlineBlame' },
  { key: 'inlineCompletions', kind: 'switch', labelKey: 'settings.editorAiCompletions' },
  { key: 'smoothScrolling', kind: 'switch', labelKey: 'settings.editorSmoothScrolling' },
];

const controls = new Map(); // key -> input/select element

function label(key) {
  const span = document.createElement('span');
  span.dataset.i18n = key;
  span.textContent = t(key);
  return span;
}

function valueRow(field) {
  const row = document.createElement('label');
  row.className = 'settings-row';
  let control;
  if (field.kind === 'select') {
    control = document.createElement('select');
    for (const value of field.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.dataset.i18n = `settings.editorOpt.${value}`;
      opt.textContent = t(`settings.editorOpt.${value}`);
      control.appendChild(opt);
    }
    control.onchange = () => setEditorSettings({ [field.key]: control.value });
  } else {
    control = document.createElement('input');
    control.type = field.kind;
    control.spellcheck = false;
    if (field.kind === 'number') { control.min = field.min; control.max = field.max; }
    if (field.placeholderKey) { control.dataset.i18nPlaceholder = field.placeholderKey; control.placeholder = t(field.placeholderKey); }
    control.onchange = () => {
      const value = field.kind === 'number' ? Number(control.value) : control.value.trim();
      setEditorSettings({ [field.key]: value });
      control.value = getEditorSettings()[field.key]; // show the clamped value
    };
  }
  row.append(label(field.labelKey), control);
  controls.set(field.key, control);
  return row;
}

function switchToggle(field) {
  const row = document.createElement('label');
  row.className = 'panel-toggle';
  const text = label(field.labelKey);
  text.className = 'panel-toggle-label';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch-input';
  input.onchange = () => setEditorSettings({ [field.key]: input.checked });
  const ui = document.createElement('span');
  ui.className = 'switch-ui';
  row.append(text, input, ui);
  controls.set(field.key, input);
  return row;
}

export function initEditorSettingsSection() {
  const group = document.getElementById('editor-settings');
  if (!group) return;
  for (const field of FIELDS.filter((f) => f.kind !== 'switch')) group.appendChild(valueRow(field));
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  for (const field of FIELDS.filter((f) => f.kind === 'switch')) grid.appendChild(switchToggle(field));
  group.appendChild(grid);
}

// Sync the controls with the current settings (the dialog is opening, or the
// editor changed a setting itself — e.g. Ctrl+= zoom or Alt+Z word wrap).
export function refreshEditorSettingsSection() {
  const settings = getEditorSettings();
  for (const [key, control] of controls) {
    if (control.type === 'checkbox') control.checked = !!settings[key];
    else control.value = settings[key];
  }
}
