// Turning a soft keyboard into remote keystrokes (Browser and Control tabs).
//
// `onKeyPress` alone isn't enough: many Android keyboards (Gboard with suggestions,
// Samsung, SwiftKey) never fire it per character — they only commit text, which RN
// reports through `onChangeText`. So the hidden input keeps a small buffer and every
// change is diffed against the previous value: what was removed becomes backspaces,
// what was added becomes typed text, and a newline becomes Enter. Only onChangeText
// is listened to, so a platform that fires both events can't type a key twice.
//
// The buffer starts as a run of invisible sentinels so a Backspace on an "empty"
// field still deletes something — and therefore still produces a change to diff.
// Plain JS rather than TypeScript so the node:test suite can import it — see
// test/mobile-remote-typing.test.mjs.

// Zero-width space: invisible, deletable, and not something a keyboard would
// autocorrect or capitalize around (a regular space would trigger iOS's
// "double space types a period").
export const SENTINEL = '​';
export const BUFFER_SEED = SENTINEL.repeat(8);
// Past this length the buffer is reset — but only at a word boundary, so an IME's
// in-progress composition isn't yanked out from under it mid-word.
const BUFFER_SOFT_MAX = 48;
const BUFFER_HARD_MAX = 256;

/**
 * @typedef {{ kind: 'backspace' } | { kind: 'enter' } | { kind: 'text', text: string }} TypedEdit
 */

// Length of the common prefix, never splitting a surrogate pair (an emoji whose
// second half differs must be treated as replaced whole).
function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i > 0 && i < a.length && isHighSurrogate(a.charCodeAt(i - 1))) i--;
  return i;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// One backspace per *character* removed (an emoji is one key press, two UTF-16 units).
function countCodePoints(s) {
  return Array.from(s).length;
}

/**
 * The keystrokes that turn the remote side's text from `prev` into `next`, assuming
 * the caret is at the end (it always is in the hidden input): delete what changed,
 * then type the replacement.
 * @param {string} prev
 * @param {string} next
 * @returns {TypedEdit[]}
 */
export function typedEdits(prev, next) {
  const shared = commonPrefixLength(prev, next);
  /** @type {TypedEdit[]} */
  const edits = [];
  const removed = countCodePoints(prev.slice(shared));
  for (let i = 0; i < removed; i++) edits.push({ kind: 'backspace' });

  const inserted = next.slice(shared).split(SENTINEL).join('');
  const lines = inserted.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index > 0) edits.push({ kind: 'enter' });
    if (line) edits.push({ kind: 'text', text: line });
  });
  return edits;
}

/**
 * The value the hidden input should hold after a change: the text itself while it
 * is still a healthy buffer, or a fresh seed once the sentinels are gone (the next
 * Backspace would have nothing to delete), a newline went in (multiline inputs keep
 * it), or the buffer has grown long.
 * @param {string} text
 * @returns {string}
 */
export function settleBuffer(text) {
  if (!text.startsWith(BUFFER_SEED)) return BUFFER_SEED;
  if (/\n/.test(text)) return BUFFER_SEED;
  if (text.length > BUFFER_HARD_MAX) return BUFFER_SEED;
  if (text.length > BUFFER_SOFT_MAX && /\s$/.test(text)) return BUFFER_SEED;
  return text;
}
