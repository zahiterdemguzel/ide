import { t } from '../../../i18n/index.js';
import { noticeDialog } from '../../shared/confirm.js';
import { matchNodes, matchEdges, crumbs, drillTarget } from '../../shared/diagram-view.js';
import { createSvg, render, applyHighlight } from './svg.js';
import { createViewport } from './viewport.js';

// --- diagram panel ---
// A center-area overlay, opened from the toolbar like the browser. It shows the
// project's structure: what classes exist, what they inherit from and call, and
// which modules depend on which.
//
// Where the work happens: nothing is parsed or laid out here. The main process
// (src/main/diagram.js -> diagram-worker.js) indexes the repo with tree-sitter
// and lays the result out with ELK; this module asks for a view and paints what
// comes back. Two calls, with very different costs:
//   refresh()  re-indexes the project from disk — on open, and on the ⟳ button
//   draw()     re-projects the index already in memory — every view switch and
//              every pass toggle, so flipping a switch never re-reads a file
//
// State that survives a close is per-repo in localStorage (the same convention
// as the browser's address history): the view, the pass switches and the
// drill-in path, so reopening the panel resumes where the user left it.

const view = document.getElementById('diagram-view');
const body = document.getElementById('diagram-body');
const statusEl = document.getElementById('diagram-status');
const searchInput = document.getElementById('diagram-search');
const crumbBar = document.getElementById('diagram-crumbs');
const toolsBar = document.getElementById('diagram-tools');
const viewToggle = document.getElementById('diagram-views');

// Mirrors DEFAULT_PASSES in src/main/diagram-lib.js. Externals and orphans
// start off: a first look at a project should be its own shape, not every
// third-party package it touches.
const DEFAULT_PASSES = {
  inheritance: true, imports: true, calls: true, instantiation: true,
  members: true, simplify: true, externals: false, orphans: false,
};

const svg = createSvg();
body.appendChild(svg);
const viewport = createViewport(svg, body);

let state = { view: 'overview', passes: { ...DEFAULT_PASSES }, focus: '' };
let current = null;   // the last diagram we painted
let repoKey = null;   // localStorage key for this repo
let open = false;
let building = false;

// --- persistence -----------------------------------------------------------

async function loadState() {
  const repo = await window.api.getRepoPath();
  repoKey = `diagram.state:${repo || ''}`;
  try {
    const saved = JSON.parse(localStorage.getItem(repoKey) || '{}');
    state = {
      view: saved.view || 'overview',
      passes: { ...DEFAULT_PASSES, ...(saved.passes || {}) },
      focus: saved.focus || '',
    };
  } catch {
    state = { view: 'overview', passes: { ...DEFAULT_PASSES }, focus: '' };
  }
}

function saveState() {
  if (repoKey) localStorage.setItem(repoKey, JSON.stringify(state));
}

// --- chrome ----------------------------------------------------------------

function syncChrome() {
  for (const opt of viewToggle.querySelectorAll('.seg-opt')) {
    opt.classList.toggle('active', opt.dataset.view === state.view);
  }
  for (const btn of toolsBar.querySelectorAll('.diag-pass')) {
    const on = state.passes[btn.dataset.pass] !== false;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  renderCrumbs();
}

function renderCrumbs() {
  crumbBar.replaceChildren();
  const trail = crumbs(state.focus, t('diagram.root'));
  trail.forEach((crumb, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'dg-crumb-sep';
      sep.textContent = '›';
      crumbBar.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'dg-crumb';
    btn.textContent = crumb.label;
    btn.disabled = i === trail.length - 1;
    btn.onclick = () => { state.focus = crumb.focus; saveState(); draw(); };
    crumbBar.appendChild(btn);
  });
}

// The status line is the panel's honesty surface: it says when the diagram is
// capped, when a language could not be parsed, and when a view came out empty —
// rather than showing a sparse picture that reads as "your project is small".
function setStatus(text, kind = '') {
  statusEl.textContent = text || '';
  statusEl.className = kind;
  statusEl.hidden = !text;
}

// Say what the reader is looking at, and — more importantly — what they are
// not. A diagram that quietly aggregated a folder of 90 files, dropped 300
// implied edges and capped at 30 boxes is telling a partial truth; the status
// line is where that gets said out loud.
function describe(diagram) {
  const meta = diagram.meta || {};
  const parts = [];
  if (!diagram.nodes.length) {
    parts.push(t('diagram.empty'));
  } else {
    if (meta.aggregated) parts.push(t('diagram.aggregated'));
    if (meta.truncated) parts.push(t('diagram.truncated').replace('{shown}', meta.shown).replace('{total}', meta.total));
    if (meta.hiddenEdges) parts.push(t('diagram.simplified').replace('{n}', meta.hiddenEdges));
    if (meta.cycles) parts.push(t('diagram.cycles').replace('{n}', meta.cycles));
  }
  if (meta.warnings && meta.warnings.length) parts.push(t('diagram.warnings').replace('{n}', meta.warnings.length));

  const serious = meta.truncated || meta.cycles || (meta.warnings || []).length;
  setStatus(parts.join(' · '), serious ? 'is-warn' : '');
}

// --- data ------------------------------------------------------------------

// Re-project and re-lay-out from the index already in the worker. `keepView`
// holds the current pan/zoom, which is what a pass toggle wants.
async function draw(keepView = false) {
  const res = await window.api.diagramLayout({ view: state.view, passes: state.passes, focus: state.focus });
  if (!res || !res.ok) {
    setStatus((res && res.error) || t('diagram.failed'), 'is-error');
    return;
  }
  current = res.diagram;
  render(svg, current);
  viewport.load(current, keepView);
  applySearch();
  describe(current);
  syncChrome();
}

// Re-index the project from disk, then draw. `force` bypasses the worker's
// per-file mtime cache — the ⟳ button's promise is a genuinely fresh read.
async function refresh(force = false) {
  if (building) return;
  building = true;
  view.classList.add('is-busy');
  setStatus(t('diagram.indexing'), 'is-busy');
  try {
    const res = await window.api.diagramBuild({ force });
    if (!res || !res.ok) {
      setStatus((res && res.error) || t('diagram.failed'), 'is-error');
      return;
    }
    await draw();
  } finally {
    building = false;
    view.classList.remove('is-busy');
  }
}

// --- search ----------------------------------------------------------------

function applySearch() {
  if (!current) return;
  const hits = matchNodes(current.nodes, searchInput.value);
  applyHighlight(svg, hits, matchEdges(current.edges, hits));
  if (hits && hits.size) {
    const first = current.nodes.find((n) => hits.has(n.id));
    if (first) viewport.reveal(first);
  }
}

// --- interaction -----------------------------------------------------------

// A click on a box opens its file — the whole point of the panel is to be a way
// into the code, not a picture to look at. A member row carries its own line, so
// clicking a method lands on the method.
body.addEventListener('click', async (e) => {
  const row = e.target.closest('.dg-row');
  const node = e.target.closest('.dg-node');
  if (!node || node.classList.contains('kind-folder')) return;
  const file = node.dataset.file;
  if (!file) return;
  const line = Number((row && row.dataset.line) || node.dataset.line || 1);
  // Imported lazily: center.js is what loads this module, so a static import
  // would close the cycle at load time.
  const { openFromTree } = await import('../center.js');
  openFromTree(file, { line });
});

// Double-click drills into a folder (or the folder holding a file), which is how
// a large project stays readable: the overview starts coarse and expands only
// where the user looks.
body.addEventListener('dblclick', (e) => {
  const g = e.target.closest('.dg-node');
  if (!g || !current) return;
  const node = current.nodes.find((n) => n.id === g.dataset.id);
  const target = drillTarget(node);
  if (target === null || target === state.focus) return;
  state.focus = target;
  saveState();
  draw();
});

viewToggle.addEventListener('click', (e) => {
  const opt = e.target.closest('.seg-opt');
  if (!opt || opt.dataset.view === state.view) return;
  state.view = opt.dataset.view;
  saveState();
  draw();
});

toolsBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.diag-pass');
  if (!btn) return;
  state.passes[btn.dataset.pass] = !(state.passes[btn.dataset.pass] !== false);
  saveState();
  draw(true); // a pass toggle should not move the camera out from under the user
});

searchInput.addEventListener('input', applySearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; applySearch(); }
});

document.getElementById('diagram-refresh').onclick = () => refresh(true);
document.getElementById('diagram-fit').onclick = () => viewport.fit();
document.getElementById('diagram-zoom-in').onclick = () => viewport.zoomBy(1.25);
document.getElementById('diagram-zoom-out').onclick = () => viewport.zoomBy(0.8);

// Warnings are one click away rather than crowding the status line.
statusEl.onclick = () => {
  const warnings = (current && current.meta && current.meta.warnings) || [];
  if (warnings.length) noticeDialog({ title: t('diagram.warningsTitle'), message: warnings.join('\n') });
};

// --- lifecycle -------------------------------------------------------------

// Opening always re-indexes: the panel's promise is that what it shows is what
// is on disk right now, and a diagram that quietly describes an older version of
// the project is worse than no diagram.
export async function openDiagram() {
  view.style.display = 'flex';
  open = true;
  if (!repoKey) await loadState();
  syncChrome();
  await refresh(false);
}

export function hideDiagram() {
  view.style.display = 'none';
  open = false;
}

export function isDiagramOpen() { return open; }

// The command palette's "Refresh diagram" — a no-op unless the panel is showing.
export function refreshDiagram() { if (open) refresh(true); }
