// The Settings → Custom Models section: search, install (pull), and uninstall
// open-source Ollama models, each showing its RAM/VRAM requirement and a warning
// when it likely won't run on this machine. Management is desktop-only; the
// installed models it produces flow into the model dropdowns via settings.js.
// This module owns only its own DOM + the Ollama IPC; it calls the `onChanged`
// callback (given by settings.js) after any install/uninstall so the shared model
// cache + dropdowns refresh.
import { t } from '../i18n/index.js';
import { confirmDialog } from './shared/confirm.js';
import { showWarning } from './shared/warn.js';

let onChanged = () => {};
let system = null; // { ramGB, vramGB, unified } — for the "Your system" hint
let searchTimer = null;

// Size in bytes -> compact "4.7 GB".
function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

// A fit warning sign (or nothing) for a model's { level } — same look/tooltip in
// the caret menu (see sessions.js).
function fitWarning(fit) {
  if (!fit || fit.level === 'ok' || fit.level === 'unknown') return null;
  const span = document.createElement('span');
  span.className = `cm-warn cm-warn-${fit.level}`;
  span.textContent = '⚠';
  span.title = t(fit.level === 'fail' ? 'settings.customModels.wontRun' : 'settings.customModels.maySlow');
  return span;
}

function catalogRow(m) {
  const row = document.createElement('div');
  row.className = 'cm-row';
  row.dataset.name = m.name;

  const info = document.createElement('div');
  info.className = 'cm-row-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'cm-row-name';
  nameEl.textContent = m.label || m.name;
  const warn = fitWarning(m.fit);
  if (warn) nameEl.appendChild(warn);
  const req = document.createElement('div');
  req.className = 'cm-row-req';
  req.textContent = m.req || '';
  info.append(nameEl, req);

  const action = document.createElement('div');
  action.className = 'cm-row-action';
  const btn = document.createElement('button');
  btn.className = 'cm-install-btn';
  btn.textContent = t('settings.customModels.install');
  const bar = document.createElement('div');
  bar.className = 'cm-progress';
  bar.hidden = true;
  const fill = document.createElement('div');
  fill.className = 'cm-progress-fill';
  bar.appendChild(fill);
  btn.onclick = () => install(m.name, btn, bar, fill);
  action.append(btn, bar);

  row.append(info, action);
  return row;
}

function installedRow(m) {
  const row = document.createElement('div');
  row.className = 'cm-row';
  const info = document.createElement('div');
  info.className = 'cm-row-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'cm-row-name';
  nameEl.textContent = m.name;
  const warn = fitWarning(m.fit);
  if (warn) nameEl.appendChild(warn);
  const meta = document.createElement('div');
  meta.className = 'cm-row-req';
  meta.textContent = [m.req, fmtSize(m.size)].filter(Boolean).join(' · ');
  info.append(nameEl, meta);

  const del = document.createElement('button');
  del.className = 'cm-uninstall-btn';
  del.textContent = t('settings.customModels.uninstall');
  del.onclick = () => uninstall(m.name);

  row.append(info, del);
  return row;
}

async function install(name, btn, bar, fill) {
  btn.disabled = true;
  btn.textContent = t('settings.customModels.installing');
  bar.hidden = false;
  fill.style.width = '0%';
  try {
    const res = await window.api.ollamaPull(name);
    if (res && res.error) throw new Error(res.error);
    // Success — the models-changed push refreshes the lists.
  } catch (err) {
    showWarning(err && err.message ? err.message : String(err), t('settings.customModels.installFailed'));
    btn.disabled = false;
    btn.textContent = t('settings.customModels.install');
    bar.hidden = true;
  }
}

async function uninstall(name) {
  const ok = await confirmDialog({
    title: t('settings.customModels.uninstall'),
    message: t('settings.customModels.uninstallConfirm').replace('{name}', name),
    ok: t('settings.customModels.uninstall'),
    danger: true,
  });
  if (!ok) return;
  const res = await window.api.ollamaRemove(name);
  if (res && res.error) showWarning(res.error, t('settings.customModels.uninstall'));
}

// Live pull progress: find the catalog row for the model and move its bar.
function onProgress(msg) {
  const catalog = document.getElementById('cm-catalog');
  const row = catalog && catalog.querySelector(`.cm-row[data-name="${CSS.escape(msg.name)}"]`);
  if (!row) return;
  const fill = row.querySelector('.cm-progress-fill');
  if (fill && typeof msg.pct === 'number') fill.style.width = `${msg.pct}%`;
}

async function loadCatalog(query) {
  const el = document.getElementById('cm-catalog');
  if (!el) return;
  const list = await window.api.ollamaCatalog(query || '');
  el.replaceChildren();
  if (Array.isArray(list)) for (const m of list) el.appendChild(catalogRow(m));
}

async function loadInstalled() {
  const el = document.getElementById('cm-installed');
  if (!el) return;
  const list = await window.api.ollamaList();
  el.replaceChildren();
  if (Array.isArray(list) && list.length) {
    for (const m of list) el.appendChild(installedRow(m));
  } else {
    const empty = document.createElement('div');
    empty.className = 'cm-empty';
    empty.textContent = t('settings.customModels.none');
    el.appendChild(empty);
  }
}

function renderSystemHint() {
  const el = document.getElementById('cm-system');
  if (!el || !system) { if (el) el.textContent = ''; return; }
  const parts = [];
  if (typeof system.ramGB === 'number') parts.push(`${system.ramGB} GB RAM`);
  if (typeof system.vramGB === 'number') parts.push(`${system.vramGB} GB VRAM`);
  else if (system.unified) parts.push(t('settings.customModels.unifiedMemory'));
  el.textContent = parts.length ? `${t('settings.customModels.yourSystem')}: ${parts.join(' · ')}` : '';
}

// Show either the setup prompt or the full body, based on engine status.
async function refreshCustomModels() {
  const statusEl = document.getElementById('cm-status');
  const body = document.getElementById('cm-body');
  if (!statusEl || !body) return;
  let status;
  try { status = await window.api.ollamaStatus(); } catch { status = null; }
  if (!status || !status.hasBinary) {
    body.hidden = true;
    statusEl.replaceChildren(noteEl(t('settings.customModels.unavailable')));
    return;
  }
  system = status.system || null;
  if (status.serveRunning) {
    statusEl.replaceChildren();
    body.hidden = false;
    renderSystemHint();
    await Promise.all([loadCatalog(document.getElementById('cm-search')?.value || ''), loadInstalled()]);
  } else {
    body.hidden = true;
    const btn = document.createElement('button');
    btn.className = 'cm-setup-btn';
    btn.textContent = t('settings.customModels.setup');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = t('settings.customModels.settingUp');
      const res = await window.api.ollamaEnsure();
      if (res && res.error) {
        showWarning(res.error, t('settings.customModels.setup'));
        btn.disabled = false;
        btn.textContent = t('settings.customModels.setup');
        return;
      }
      await refreshCustomModels();
    };
    statusEl.replaceChildren(btn);
  }
}

function noteEl(text) {
  const el = document.createElement('div');
  el.className = 'cm-note';
  el.textContent = text;
  return el;
}

export function initCustomModels(changed) {
  onChanged = typeof changed === 'function' ? changed : () => {};
  const search = document.getElementById('cm-search');
  if (search) {
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadCatalog(search.value), 150);
    };
  }
  const removeAll = document.getElementById('cm-remove-all');
  if (removeAll) {
    removeAll.onclick = async () => {
      const ok = await confirmDialog({
        title: t('settings.customModels.removeAll'),
        message: t('settings.customModels.removeAllConfirm'),
        ok: t('settings.customModels.removeAll'),
        danger: true,
      });
      if (!ok) return;
      const res = await window.api.ollamaRemoveAll();
      if (res && res.error) showWarning(res.error, t('settings.customModels.removeAll'));
    };
  }
  window.api?.onOllamaPullProgress?.(onProgress);
  // Any install/uninstall (here or from another client) refreshes the section and
  // notifies settings.js to re-fill the model dropdowns.
  window.api?.onOllamaModelsChanged?.(() => { refreshCustomModels(); onChanged(); });
}

export { refreshCustomModels };
