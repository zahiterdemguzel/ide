import { runSpecInConsole } from '../consoles.js';
import { confirmDialog } from '../shared/confirm.js';
import { promptText } from '../shared/prompt.js';
import { extOf } from '../shared/ext.js';
import { t } from '../../i18n/index.js';

// The i18n engine has no interpolation, so fill {placeholder}s from a locale
// string here (keeps the translatable text whole in the locale files).
function fmt(key, vars = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// The editor's Run split-button: a square Play button plus a narrower caret that
// opens a small options menu. Shown only while a *runnable* file is mounted
// (code-render hides #run-split on every view switch; file.js calls showRunFor
// after a runnable file mounts). Running resolves the file → interpreter in main
// and opens the command in a git-pane terminal tab, reusing the file's tab.

const split = document.getElementById('run-split');
const runBtn = document.getElementById('run-btn');
const menuBtn = document.getElementById('run-menu-btn');

let langs = []; // [{ id, name, exts, interpreter }] — cached from main
let currentFile = null;
let currentLang = null;

async function loadLangs() {
  try { langs = (await window.api.getRunnerLangs()).langs || []; }
  catch { langs = []; }
}
loadLangs();

function langForFile(file) {
  const ext = extOf(file);
  return langs.find((l) => l.exts.includes(ext)) || null;
}

// Called by file.js after a text file mounts. Reveals the button for runnable
// files; for anything else the button stays hidden (code-render already hid it).
export function showRunFor(file) {
  currentFile = file;
  currentLang = langForFile(file);
  if (!currentLang) { split.hidden = true; return; }
  split.hidden = false;
  runBtn.title = fmt('run.runFile', { lang: currentLang.name });
}

async function run(args = '') {
  if (!currentFile) return;
  split.classList.add('busy');
  const r = await window.api.resolveRunner({ file: currentFile, args });
  split.classList.remove('busy');
  if (!r || r.unsupported) return;
  if (r.needsInterpreter) { await offerInterpreter(r.lang); return; }
  if (r.ok) runSpecInConsole(r.run);
}

// The "we couldn't find the binaries this language needs — register one" flow.
async function offerInterpreter(lang) {
  const ok = await confirmDialog({
    title: fmt('run.notFoundTitle', { lang: lang.name }),
    message: fmt('run.notFoundMsg', { lang: lang.name }),
    ok: t('run.locate'),
  });
  if (!ok) return;
  await selectInterpreter(lang.id);
  await run(); // retry now that an interpreter is registered (no-op if cancelled)
}

async function selectInterpreter(langId) {
  const res = await window.api.pickInterpreter({ langId });
  if (res && res.ok) await loadLangs();
  return res && res.ok;
}

// ── Run options menu (the caret) ─────────────────────────────────────────────
let menuDismiss = null;
function closeMenu() {
  const m = document.getElementById('run-menu');
  if (m) m.remove();
  menuBtn.classList.remove('open');
  if (menuDismiss) { document.removeEventListener('pointerdown', menuDismiss, true); menuDismiss = null; }
}

function menuItem(label, onClick) {
  const b = document.createElement('button');
  b.className = 'run-menu-item';
  b.textContent = label;
  b.onclick = () => { closeMenu(); onClick(); };
  return b;
}

function openMenu() {
  closeMenu();
  if (!currentLang) return;
  const cur = langs.find((l) => l.id === currentLang.id) || currentLang;
  const menu = document.createElement('div');
  menu.id = 'run-menu';

  const info = document.createElement('div');
  info.className = 'run-menu-info';
  info.textContent = cur.interpreter
    ? fmt('run.interpreter', { path: cur.interpreter })
    : fmt('run.interpreterAuto', { lang: cur.name });
  info.title = cur.interpreter || '';
  menu.appendChild(info);

  menu.appendChild(menuItem(t('run.withArgs'), async () => {
    const a = await promptText({
      title: fmt('run.withArgsTitle', { name: currentFile.split(/[\\/]/).pop() }),
      label: fmt('run.withArgsLabel', { lang: currentLang.name }),
      placeholder: '--flag value',
      ok: t('run.runBtn'),
    });
    if (a !== null) run(a);
  }));
  menu.appendChild(menuItem(t('run.selectInterpreter'), () => selectInterpreter(currentLang.id)));
  if (cur.interpreter) {
    menu.appendChild(menuItem(t('run.resetInterpreter'), async () => {
      await window.api.clearInterpreter({ langId: currentLang.id });
      await loadLangs();
    }));
  }

  document.body.appendChild(menu);
  const r = menuBtn.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menuBtn.classList.add('open');
  menuDismiss = (e) => { if (!e.target.closest('#run-menu') && e.target !== menuBtn && !menuBtn.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', menuDismiss, true), 0);
}

runBtn.onclick = () => run();
menuBtn.onclick = () => { if (document.getElementById('run-menu')) closeMenu(); else openMenu(); };
