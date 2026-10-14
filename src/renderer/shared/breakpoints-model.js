// Pure breakpoint bookkeeping for the debugger (DOM-free, unit-tested).
// A breakpoint is { line, enabled, condition?, hitCondition?, logMessage? }, and
// a file's list is kept sorted by line with at most one entry per line.

const byLine = (a, b) => a.line - b.line;

// Click in the gutter: add a plain breakpoint, or remove the one that's there.
export function toggleBreakpointAt(list, line) {
  if (list.some((bp) => bp.line === line)) return list.filter((bp) => bp.line !== line);
  return [...list, { line, enabled: true }].sort(byLine);
}

// Add or replace the breakpoint on `bp.line` (the condition / logpoint editor).
export function upsertBreakpoint(list, bp) {
  return [...list.filter((b) => b.line !== bp.line), { enabled: true, ...bp }].sort(byLine);
}

// Only enabled breakpoints reach the adapter — disabling is a UI-side switch.
export function enabledBreakpoints(list) {
  return (list || []).filter((bp) => bp.enabled !== false);
}

// Where an edit happened, from the text before and after it: the 1-based line
// holding the first changed character, whether that character was at the very
// start of its line, and how many lines were added (+) or removed (-).
export function describeEdit(before, after) {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  const head = before.slice(0, prefix);
  const line = head.split('\n').length;
  const atLineStart = prefix === 0 || head.endsWith('\n');
  const delta = after.split('\n').length - before.split('\n').length;
  return { line, atLineStart, delta };
}

// Keep breakpoints on the code they were set on as lines are inserted/removed
// above them (VS Code's behaviour). Lines merged away by a deletion lose their
// breakpoint; Enter at the very start of a breakpoint's line pushes it down.
export function shiftBreakpoints(list, { line, atLineStart, delta }) {
  if (!delta) return list;
  const out = [];
  for (const bp of list) {
    const movesWithEdit = bp.line > line || (bp.line === line && atLineStart && delta > 0);
    if (!movesWithEdit) { out.push(bp); continue; }
    if (delta < 0 && bp.line <= line - delta) continue; // its line was deleted
    out.push({ ...bp, line: bp.line + delta });
  }
  // A deletion can land two breakpoints on one line; keep the first.
  const seen = new Set();
  return out.filter((bp) => !seen.has(bp.line) && seen.add(bp.line)).sort(byLine);
}
