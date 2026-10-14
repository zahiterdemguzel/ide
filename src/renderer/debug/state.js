// Debugger state shared by the editor (gutter breakpoints, paused line) and the
// debug panel: breakpoints per file, persisted per project, and where execution
// is paused. DOM-free so both sides can import it without a cycle.
import {
  toggleBreakpointAt, upsertBreakpoint, enabledBreakpoints, describeEdit, shiftBreakpoints,
} from '../shared/breakpoints-model.js';

let repo = null;
let breakpoints = new Map(); // repo-relative file -> [{ line, enabled, condition?, … }]
// file -> Set of lines the adapter reported as unverified (no code there, file
// not loaded yet). Shown hollow, as in VS Code.
const unverified = new Map();
let execLocation = null; // { file, line } while paused in a file of this repo

const listeners = new Set();
export function onDebugDecorationsChanged(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify() { for (const cb of listeners) cb(); }

const storageKey = () => `debug.breakpoints:${repo}`;

function persist() {
  try { localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(breakpoints))); }
  catch { /* storage unavailable: breakpoints just won't survive a restart */ }
}

function sendFile(file) {
  window.api.debugSetBreakpoints({ file, breakpoints: enabledBreakpoints(breakpoints.get(file)) });
}

// Load the opened folder's breakpoints and hand them all to main. Called on
// every toolbar rebuild, so it no-ops unless the folder actually changed.
export async function syncBreakpointsForRepo() {
  let current = null;
  try { current = await window.api.getRepoPath(); } catch { /* no folder */ }
  if (current === repo) return;
  repo = current;
  breakpoints = new Map();
  unverified.clear();
  execLocation = null;
  if (repo) {
    try { breakpoints = new Map(Object.entries(JSON.parse(localStorage.getItem(storageKey()) || '{}'))); }
    catch { breakpoints = new Map(); }
  }
  const all = {};
  for (const [file, list] of breakpoints) all[file] = enabledBreakpoints(list);
  window.api.debugSetBreakpoints({ all });
  notify();
}

export function getBreakpoints(file) { return breakpoints.get(file) || []; }
export function allBreakpoints() { return [...breakpoints].flatMap(([file, list]) => list.map((bp) => ({ file, ...bp }))); }
export function isUnverified(file, line) { return !!(unverified.get(file) && unverified.get(file).has(line)); }

function setList(file, list) {
  if (list.length) breakpoints.set(file, list); else breakpoints.delete(file);
  persist();
  sendFile(file);
  notify();
}

export function toggleBreakpoint(file, line) { setList(file, toggleBreakpointAt(getBreakpoints(file), line)); }
export function saveBreakpoint(file, bp) { setList(file, upsertBreakpoint(getBreakpoints(file), bp)); }
export function removeBreakpoint(file, line) { setList(file, getBreakpoints(file).filter((bp) => bp.line !== line)); }
export function setBreakpointEnabled(file, line, enabled) {
  setList(file, getBreakpoints(file).map((bp) => (bp.line === line ? { ...bp, enabled } : bp)));
}
export function removeAllBreakpoints() {
  const files = [...breakpoints.keys()];
  breakpoints.clear();
  persist();
  for (const file of files) sendFile(file);
  notify();
}

// The editor reports each text change so breakpoints ride along with their code.
export function applyEditToBreakpoints(file, before, after) {
  const list = getBreakpoints(file);
  if (!list.length) return;
  const shifted = shiftBreakpoints(list, describeEdit(before, after));
  if (shifted !== list) setList(file, shifted);
}

// The adapter's verdict per breakpoint (`setBreakpoints` response / breakpoint event).
export function setVerification(file, results) {
  const lines = new Set();
  for (const r of results || []) if (r && r.verified === false && r.line) lines.add(r.line);
  unverified.set(file, lines);
  notify();
}

export function getExecLocation() { return execLocation; }
export function setExecLocation(loc) {
  execLocation = loc;
  notify();
}
