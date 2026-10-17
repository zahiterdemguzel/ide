// Everything the editor draws in its margins for the active file:
//   - debugger breakpoints (glyph margin: click / F9 toggles, right-click edits)
//     and the paused-execution line,
//   - git change markers against HEAD (green added / blue modified / red
//     deleted bars, also mirrored in the minimap and overview ruler),
//   - inline blame after the caret's line ("Ada, 3 days ago · Fix parser").
// The breakpoint *state* (lines, verification, conditions) lives in
// debug/state.js; this module only renders it and forwards gestures.

import {
  getBreakpoints, toggleBreakpoint, isUnverified, applyEditToBreakpoints,
  getExecLocation, onDebugDecorationsChanged,
} from '../debug/state.js';
import { lineChanges } from './line-diff.js';
import { relativeTime } from './symbol-path.js';
import { currentLocale, t } from '../../i18n/index.js';

let monaco = null;
let editor = null;
let current = null; // { doc } of the file shown, or null
let host = null;    // { editBreakpoint(file, line), settings() }

let breakpointDecos = null;
let execDecos = null;
let hoverDecos = null;
let gitDecos = null;
let blameDecos = null;

const headTextCache = new Map(); // file -> committed text (or null for untracked/new)
let gitTimer = null;
let blameTimer = null;
let blameRequest = 0;

export function initGutter(monacoNs, editorInstance, hostCallbacks) {
  monaco = monacoNs;
  editor = editorInstance;
  host = hostCallbacks;
  breakpointDecos = editor.createDecorationsCollection();
  execDecos = editor.createDecorationsCollection();
  hoverDecos = editor.createDecorationsCollection();
  gitDecos = editor.createDecorationsCollection();
  blameDecos = editor.createDecorationsCollection();

  const { MouseTargetType } = monaco.editor;
  editor.onMouseDown((e) => {
    if (!current || e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    if (e.event.rightButton) return;
    toggleBreakpoint(current.doc.file, e.target.position.lineNumber);
  });
  editor.onContextMenu((e) => {
    if (!current || e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    e.event.preventDefault();
    host.editBreakpoint(current.doc.file, e.target.position.lineNumber);
  });
  // VS Code's faint "click to add a breakpoint here" dot.
  editor.onMouseMove((e) => {
    const line = current && e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position.lineNumber : 0;
    const hasBreakpoint = line && getBreakpoints(current.doc.file).some((bp) => bp.line === line);
    hoverDecos.set(line && !hasBreakpoint
      ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-glyph bp-hint' } }]
      : []);
  });
  editor.onMouseLeave(() => hoverDecos.clear());

  editor.onDidChangeCursorPosition(() => scheduleBlame());
  onDebugDecorationsChanged(() => {
    if (!current) return;
    current.doc.breakpointBase = current.doc.model.getValue();
    paintBreakpoints();
    paintExec();
  });
}

// The editor switched to `doc` (or to nothing).
export function showGutterFor(doc) {
  current = doc ? { doc } : null;
  hoverDecos.clear();
  blameDecos.clear();
  if (!doc) { breakpointDecos.clear(); execDecos.clear(); gitDecos.clear(); return; }
  doc.breakpointBase = getBreakpoints(doc.file).length ? doc.model.getValue() : null;
  paintBreakpoints();
  paintExec();
  refreshGitBaseline(doc.file);
  scheduleBlame();
}

// Called on every content change of the shown doc.
export function onContentChanged(doc) {
  if (!current || current.doc !== doc) return;
  // Breakpoints ride along with their lines (describeEdit/shiftBreakpoints in
  // breakpoints-model.js work on before/after text, so we only keep a copy of
  // the text while the file actually has breakpoints).
  if (getBreakpoints(doc.file).length) {
    const after = doc.model.getValue();
    applyEditToBreakpoints(doc.file, doc.breakpointBase ?? after, after);
    doc.breakpointBase = after;
  } else {
    doc.breakpointBase = null;
  }
  clearTimeout(gitTimer);
  gitTimer = setTimeout(paintGit, 250);
  blameDecos.clear();
  scheduleBlame();
}

// ── Debugger ────────────────────────────────────────────────────────────────

function paintBreakpoints() {
  const { file } = current.doc;
  breakpointDecos.set(getBreakpoints(file).map((bp) => {
    let cls = 'bp-glyph';
    if (bp.logMessage) cls += ' bp-log';
    if (bp.condition || bp.hitCondition) cls += ' bp-cond';
    if (bp.enabled === false) cls += ' bp-off';
    else if (isUnverified(file, bp.line)) cls += ' bp-unverified';
    const hover = bp.logMessage ? `Logpoint: ${bp.logMessage}`
      : bp.condition ? `Breakpoint if ${bp.condition}`
        : bp.hitCondition ? `Breakpoint after ${bp.hitCondition} hits` : 'Breakpoint';
    return {
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: { glyphMarginClassName: cls, glyphMarginHoverMessage: { value: hover }, stickiness: 1 },
    };
  }));
}

function paintExec() {
  const exec = getExecLocation();
  if (!exec || exec.file !== current.doc.file) { execDecos.clear(); return; }
  execDecos.set([{
    range: new monaco.Range(exec.line, 1, exec.line, 1),
    options: { isWholeLine: true, className: 'exec-line', glyphMarginClassName: 'exec-glyph', zIndex: 10 },
  }]);
  editor.revealLineInCenterIfOutsideViewport(exec.line);
}

// ── Git change markers ──────────────────────────────────────────────────────

async function refreshGitBaseline(file) {
  if (!headTextCache.has(file)) {
    const r = file.startsWith('/') || /^[A-Za-z]:/.test(file) ? null : await window.api.gitHeadText(file);
    headTextCache.set(file, r && r.ok ? r.text : null);
  }
  paintGit();
}

// The committed baseline changes when the user commits/checks out; drop the
// cache so the next paint re-reads it.
export function invalidateGitBaselines() {
  headTextCache.clear();
  if (current) refreshGitBaseline(current.doc.file);
}

function paintGit() {
  if (!current) return;
  const base = headTextCache.get(current.doc.file);
  if (base == null) { gitDecos.clear(); return; }
  const changes = lineChanges(base, current.doc.model.getValue());
  const colors = { added: 'var(--green)', modified: 'var(--accent)', deleted: 'var(--red)' };
  gitDecos.set(changes.map((c) => {
    const line = Math.max(1, c.start);
    const end = c.type === 'deleted' ? line : c.end;
    return {
      range: new monaco.Range(line, 1, end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `git-${c.type}${c.type === 'deleted' && c.start === 0 ? ' at-top' : ''}`,
        overviewRuler: { color: colors[c.type], position: monaco.editor.OverviewRulerLane.Left },
        minimap: { color: colors[c.type], position: monaco.editor.MinimapPosition.Gutter },
      },
    };
  }));
}

// ── Inline blame ────────────────────────────────────────────────────────────

function scheduleBlame() {
  clearTimeout(blameTimer);
  blameTimer = setTimeout(paintBlame, 400);
}

async function paintBlame() {
  if (!current || !host.settings().inlineBlame || current.doc.readOnly) { blameDecos.clear(); return; }
  const { doc } = current;
  const pos = editor.getPosition();
  if (!pos || headTextCache.get(doc.file) == null) { blameDecos.clear(); return; }
  const request = ++blameRequest;
  const blame = await window.api.gitBlameLine({ file: doc.file, line: pos.lineNumber, text: doc.model.getValue() });
  if (request !== blameRequest || !current || current.doc !== doc) return;
  const now = editor.getPosition();
  if (!blame || !now || now.lineNumber !== pos.lineNumber) { blameDecos.clear(); return; }
  const text = blame.uncommitted
    ? t('editor.blameUncommitted')
    : `${blame.author}, ${relativeTime(blame.time, Date.now(), currentLocale())} · ${blame.summary}`;
  const maxColumn = doc.model.getLineMaxColumn(pos.lineNumber);
  blameDecos.set([{
    range: new monaco.Range(pos.lineNumber, maxColumn, pos.lineNumber, maxColumn),
    options: {
      after: { content: `    ${text}`, inlineClassName: 'inline-blame' },
      hoverMessage: blame.uncommitted ? undefined : { value: `**${blame.author}** · ${new Date(blame.time).toLocaleString()}\n\n${blame.summary}\n\n\`${blame.hash.slice(0, 10)}\`` },
    },
  }]);
}
