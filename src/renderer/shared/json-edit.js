// Pure JSON structure-editing helper for the file editor's JSON action buttons.
// Given the buffer text and the caret offset, jsonInsertion() finds the
// innermost array/object containing the caret and builds the text edit that
// appends a new element (array) or a new "key": "" entry (object) to it,
// matching the container's existing layout (inline vs multiline) and indent.
// Electron-free so it's unit-testable (test/json-edit.test.mjs).

// Indent for the line containing offset `p`.
function indentOf(text, p) {
  const lineStart = text.lastIndexOf('\n', p - 1) + 1;
  return (text.slice(lineStart).match(/^[ \t]*/) || [''])[0];
}

// One indent step, guessed from the file's first indented line ('  ' fallback).
function indentUnit(text) {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return '  ';
  return m[1][0] === '\t' ? '\t' : m[1];
}

// Innermost container ('{'/'[') whose brackets enclose `offset`, with its
// matching close index — or null when the caret sits outside any container or
// the container is unclosed. Strings (with escapes) are skipped so brackets in
// string values never confuse the scan.
function containerAt(text, offset) {
  const stack = [];
  let target = null;
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    if (target === null && i >= offset) {
      if (!stack.length) return null;
      target = stack[stack.length - 1];
    }
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push({ ch: c, open: i });
    else if (c === '}' || c === ']') {
      const top = stack.pop();
      if (top && top === target) return { ...top, close: i };
    }
  }
  return null; // caret past EOF-adjacent container or container never closed
}

// Build the edit that adds an entry to the innermost container around `offset`:
// { type: 'array'|'object', at, insert, selStart, selEnd } — insert `insert` at
// offset `at`, then place the selection at [selStart, selEnd] in the new text
// (the "key" of a new object entry, or between the quotes of a new array
// value, so typing immediately replaces the placeholder). Null when the caret
// isn't inside a well-formed container.
export function jsonInsertion(text, offset) {
  const c = containerAt(text, offset);
  if (!c) return null;
  const type = c.ch === '{' ? 'object' : 'array';
  const placeholder = type === 'object' ? '"key": ""' : '""';
  // Selection within the placeholder: the word `key`, or between the quotes.
  const selFrom = 1;
  const selTo = type === 'object' ? 4 : 1;

  // Last non-whitespace char between the brackets — the tail of the last
  // element, or the open bracket itself when the container is empty.
  let last = c.close - 1;
  while (last > c.open && /\s/.test(text[last])) last--;
  const empty = last === c.open;
  const multiline = text.slice(c.open + 1, c.close).includes('\n');

  let at, insert;
  if (empty) {
    at = multiline ? c.open + 1 : c.close;
    insert = multiline ? '\n' + indentOf(text, c.open) + indentUnit(text) + placeholder : placeholder;
  } else {
    at = last + 1;
    const comma = text[last] === ',' ? '' : ','; // tolerate an existing trailing comma
    insert = multiline
      ? comma + '\n' + indentOf(text, last) + placeholder
      : comma + ' ' + placeholder;
  }
  const phStart = at + insert.length - placeholder.length;
  return { type, at, insert, selStart: phStart + selFrom, selEnd: phStart + selTo };
}
