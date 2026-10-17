// Pure (Electron-free) logic behind the editor's AI assist: the prompts for
// ghost-text completions (fill-in-the-middle) and Cmd/Ctrl+K inline edits, the
// cleaners that turn a raw model reply into text safe to insert, and the model
// fallback policy. The IPC/HTTP wiring lives in ai-assist.js; everything here is
// unit-tested in test/ai-assist-lib.test.mjs.

const COMPLETION_PREFIX_CHARS = 4000;
const COMPLETION_SUFFIX_CHARS = 2000;
const COMPLETION_MAX_LINES = 12;
const EDIT_PREFIX_CHARS = 6000;
const EDIT_SUFFIX_CHARS = 3000;

// Model ids per role, best first. A role memoises the first id the API accepts,
// so the fallbacks only cost a round-trip once per app run.
const HAIKU_FALLBACK = 'claude-haiku-4-5-20251001';
const MODEL_ORDER = {
  complete: ['claude-haiku-5-5', HAIKU_FALLBACK],
  edit: ['claude-sonnet-5-5', 'claude-sonnet-4-5', HAIKU_FALLBACK],
};

// Per-model request fields. The 5.5 models think by default, which is pure
// latency for a short fill-in: Haiku 5.5 accepts `disabled` (at its default
// effort); Sonnet 5.5 rejects `disabled` and turns thinking off with
// `between_tools` instead. Older models don't think unless asked.
function requestExtrasFor(model) {
  if (model === 'claude-haiku-5-5') return { thinking: { type: 'disabled' } };
  if (model === 'claude-sonnet-5-5') return { thinking: { type: 'between_tools' } };
  return {};
}

// Whether a failed call means "this model id/config isn't usable here — try the
// next one" (400 invalid request / 404 not found) rather than a failure the next
// model would hit too (auth, rate limit, network, abort, server error).
function isModelRejection(result) {
  if (!result || result.ok || result.aborted) return false;
  return result.status === 404 || result.status === 400
    || result.errorType === 'not_found_error';
}

// --- Context windows ----------------------------------------------------------

// The last `max` chars of the text before the cursor, started on a line boundary
// when one is near so the model never sees half a line at the top.
function prefixWindow(prefix, max = COMPLETION_PREFIX_CHARS) {
  const text = String(prefix || '');
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const firstBreak = cut.indexOf('\n');
  return firstBreak !== -1 && firstBreak < max / 4 ? cut.slice(firstBreak + 1) : cut;
}

// The first `max` chars after the cursor, ended on a line boundary when one is near.
function suffixWindow(suffix, max = COMPLETION_SUFFIX_CHARS) {
  const text = String(suffix || '');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > max * 0.75 ? cut.slice(0, lastBreak) : cut;
}

const firstLine = (text) => String(text || '').split('\n')[0];
const lastLine = (text) => { const lines = String(text || '').split('\n'); return lines[lines.length - 1]; };
const fileHeader = (language, path) => `File: ${path || 'untitled'}${language ? ` (${language})` : ''}`;

// Ghost text is pointless when the cursor sits inside a word (the user is
// mid-identifier and an insertion would split it).
function shouldSkipCompletion({ prefix, suffix }) {
  const before = String(prefix || '').slice(-1);
  const after = String(suffix || '').slice(0, 1);
  return /\w/.test(before) && /\w/.test(after);
}

// --- Prompts -------------------------------------------------------------------

const FILL_MARKER = '<|CURSOR|>';
const FILL_TAG = 'fill';
const EDIT_TAG = 'replacement';

const COMPLETION_SYSTEM = 'You are a code completion engine inside an IDE. You are shown a file '
  + `with the cursor marked ${FILL_MARKER}. Predict the code the developer is about to type at the `
  + 'cursor: usually the rest of the current line, or a few lines when a block is obviously '
  + 'starting. Rules: output only the text to insert, wrapped in <fill></fill>; never repeat '
  + 'text that is already before or after the cursor; match the file\'s indentation and style; '
  + 'no explanations and no markdown. If nothing useful should be inserted, output <fill></fill>.';

// `snippets`: optional [{ path, text }] of related code (open files, definitions).
function buildCompletionPrompt({ language, path, prefix, suffix, snippets = [] }) {
  const before = prefixWindow(prefix);
  const after = suffixWindow(suffix);
  const context = snippets.filter((s) => s && s.text).slice(0, 4)
    .map((s) => `<snippet path="${s.path || ''}">\n${String(s.text).slice(0, 1500)}\n</snippet>`)
    .join('\n');
  const user = (context ? `Related code:\n${context}\n\n` : '')
    + `${fileHeader(language, path)}\n<file>\n${before}${FILL_MARKER}${after}\n</file>\n\n`
    + `Output the text to insert at ${FILL_MARKER}, wrapped in <fill></fill>.`;
  return { system: COMPLETION_SYSTEM, user, stopSequences: [`</${FILL_TAG}>`] };
}

const EDIT_SYSTEM = 'You are an expert programmer editing code inside an IDE. You receive a '
  + 'file excerpt, a selected region, and an instruction. Rewrite the selected region so it '
  + 'fulfils the instruction. Rules: output only the replacement code for the selected region, '
  + 'wrapped in <replacement></replacement>; keep the indentation of the surrounding code; do '
  + 'not repeat code from outside the selection; keep everything the instruction does not ask '
  + 'to change; comments are fine but no prose outside the code and no markdown fences.';

const GENERATE_SYSTEM = 'You are an expert programmer writing code inside an IDE. You receive '
  + `a file excerpt with the cursor marked ${FILL_MARKER} and an instruction. Write the code to `
  + 'insert at the cursor. Rules: output only the new code, wrapped in '
  + '<replacement></replacement>; match the indentation and style of the surrounding code; do '
  + 'not repeat existing code; no prose and no markdown fences.';

// `selection` is the original selected text ('' = generate at the cursor);
// `previous` is the current proposal when the user refines it with a follow-up.
function buildEditPrompt({ language, path, instruction, selection, prefix, suffix, previous }) {
  const before = prefixWindow(prefix, EDIT_PREFIX_CHARS);
  const after = suffixWindow(suffix, EDIT_SUFFIX_CHARS);
  const generating = !String(selection || '').trim();
  const header = fileHeader(language, path);
  let user;
  if (generating) {
    user = `${header}\n<file>\n${before}${FILL_MARKER}${after}\n</file>\n\n`;
  } else {
    user = `${header}\n<before_selection>\n${before}\n</before_selection>\n`
      + `<selection>\n${selection}\n</selection>\n`
      + `<after_selection>\n${after}\n</after_selection>\n\n`;
  }
  if (previous != null) {
    user += `Your current proposal for the ${generating ? 'insertion' : 'selection'} is:\n`
      + `<proposal>\n${previous}\n</proposal>\n\n`
      + `Revise the proposal according to this follow-up instruction: ${instruction}\n`;
  } else {
    user += `Instruction: ${instruction}\n`;
  }
  user += `\nOutput the complete ${generating ? 'code to insert' : 'replacement for the selection'}, wrapped in <replacement></replacement>.`;
  return { system: generating ? GENERATE_SYSTEM : EDIT_SYSTEM, user, stopSequences: [`</${EDIT_TAG}>`] };
}

// --- Output cleaners -----------------------------------------------------------

// Text inside <tag>…</tag>. The closing tag is usually swallowed by the stop
// sequence, so an open tag alone is enough; no tag at all returns the input.
// `trimFormatting` drops the newline right after the open tag and before the
// close — layout for a block reply, but meaningful in a fill-in (a completion
// after `{` legitimately starts with a newline).
function extractTagged(text, tag, { trimFormatting = true } = {}) {
  const raw = String(text || '');
  const open = raw.indexOf(`<${tag}>`);
  if (open === -1) return raw.replace(new RegExp(`</?${tag}\\s*/?>`, 'g'), '');
  let inner = raw.slice(open + tag.length + 2);
  const close = inner.indexOf(`</${tag}>`);
  if (close !== -1) inner = inner.slice(0, close);
  return trimFormatting ? inner.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '') : inner;
}

// The body of the first ``` fence if the reply is wrapped in one.
function stripFences(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```[\w+#.-]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$)/);
  if (fenced && raw.trimStart().startsWith('```')) return fenced[1];
  if (fenced && /^[^\n]*:\s*\n```/.test(raw.trimStart())) return fenced[1];
  return raw;
}

const PREAMBLE = /^(here('s| is| are)|sure|certainly|okay|ok,|the (completion|code|replacement|updated|result))\b[^\n]*:\s*$/i;

function stripPreamble(text) {
  const lines = String(text || '').split('\n');
  if (lines.length > 1 && PREAMBLE.test(lines[0].trim())) return lines.slice(1).join('\n');
  return lines.join('\n');
}

const REFUSAL = /^(i('m| am)? (sorry|unable|not able)|i can(no|')t|as an ai|no (completion|suggestion|change)s?\b|n\/a$|none$)/i;

const BRACKET_DEPTH = { '(': 1, '[': 1, '{': 1, ')': -1, ']': -1, '}': -1 };
function netBracketDepth(text) {
  let depth = 0;
  for (const ch of text) depth += BRACKET_DEPTH[ch] || 0;
  return depth;
}

// Strip text the model repeated from just before the cursor: the current line's
// typed text, or any longer (≥ 8 chars) tail of the prefix.
function trimPrefixOverlap(completion, prefix) {
  const typedOnLine = lastLine(prefix).trimStart();
  if (typedOnLine.length >= 3 && completion.startsWith(typedOnLine)) {
    return completion.slice(typedOnLine.length);
  }
  const maxOverlap = Math.min(completion.length, prefix.length, 200);
  for (let k = maxOverlap; k >= 8; k--) {
    if (prefix.endsWith(completion.slice(0, k))) return completion.slice(k);
  }
  return completion;
}

// Strip a tail that the text after the cursor already starts with — the classic
// duplicated `)` or closing `}` line. Short overlaps are only trimmed when that
// fixes the bracket balance, so `foo()` before a `)` stays intact.
function trimSuffixOverlap(completion, suffix) {
  const head = String(suffix || '').slice(0, 200);
  const maxOverlap = Math.min(completion.length, head.length);
  for (let k = maxOverlap; k >= 1; k--) {
    const tail = completion.slice(completion.length - k);
    if (!head.startsWith(tail)) continue;
    const trimmed = completion.slice(0, completion.length - k);
    if (!tail.trim()) continue;
    const fixesBalance = Math.abs(netBracketDepth(trimmed)) < Math.abs(netBracketDepth(completion));
    if (k >= 6 || fixesBalance) return trimmed;
  }
  return completion;
}

// Keep completions short: cut at the last blank line within `maxLines`, or hard
// at `maxLines` when there is none.
function capLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, maxLines);
  let blank = -1;
  for (let i = head.length - 1; i >= 1; i--) if (!head[i].trim()) { blank = i; break; }
  return (blank > 0 ? head.slice(0, blank) : head).join('\n');
}

// Raw model reply -> ghost text to insert at the cursor ('' = show nothing).
function cleanCompletion(raw, { prefix = '', suffix = '', maxLines = COMPLETION_MAX_LINES } = {}) {
  let text = stripPreamble(stripFences(extractTagged(raw, FILL_TAG, { trimFormatting: false })))
    .replace(/\r\n/g, '\n');
  if (!text.trim() || REFUSAL.test(text.trim())) return '';
  if (text.includes(FILL_MARKER)) return '';
  text = trimPrefixOverlap(text, prefix);
  // On a line holding only the indent typed so far, the model often repeats it.
  const typedIndent = lastLine(prefix);
  if (typedIndent && !typedIndent.trim() && text.startsWith(typedIndent)) text = text.slice(typedIndent.length);
  text = trimSuffixOverlap(text, suffix);
  // Text after the cursor on this line means the insertion must stay on one line.
  if (firstLine(suffix).trim() && text.includes('\n')) text = text.slice(0, text.indexOf('\n'));
  text = capLines(text, maxLines).replace(/\s+$/, '');
  // A completion right after a newline may begin with indentation; one at the
  // start of a fresh line must not begin with a stray newline.
  if (!lastLine(prefix).trim() && text.startsWith('\n')) text = text.replace(/^\n+/, '');
  if (!text.trim()) return '';
  if (firstLine(suffix).startsWith(text)) return '';
  return text;
}

const leadingWhitespace = (line) => line.match(/^[ \t]*/)[0];

// The indentation shared by every non-blank line.
function commonIndent(text) {
  let common = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const indent = leadingWhitespace(line);
    if (common === null || indent.length < common.length) common = indent;
  }
  return common || '';
}

// Shift a block so its least-indented line sits at `baseIndent`.
function reindent(text, baseIndent) {
  const current = commonIndent(text);
  if (current === baseIndent) return text;
  return text.split('\n')
    .map((line) => (line.trim() ? baseIndent + line.slice(current.length) : ''))
    .join('\n');
}

// Raw model reply -> replacement for the (whole-line) selection. `baseIndent`
// is the indentation the block should sit at (the selection's common indent, or
// the cursor line's indent when generating); null keeps the model's own
// indentation (generating on an empty line, where only the model knows the
// nesting). Returns '' for an intentional empty replacement and null when the
// reply is junk (prose / refusal).
function cleanEdit(raw, { baseIndent = '' } = {}) {
  const source = String(raw || '').replace(/\r\n/g, '\n');
  const tagged = source.includes(`<${EDIT_TAG}>`);
  let text = stripPreamble(stripFences(extractTagged(source, EDIT_TAG)));
  if (!tagged && REFUSAL.test(text.trim())) return null;
  text = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  if (!text) return tagged ? '' : null;
  return baseIndent == null ? text : reindent(text, baseIndent);
}

module.exports = {
  MODEL_ORDER,
  HAIKU_FALLBACK,
  COMPLETION_PREFIX_CHARS,
  COMPLETION_SUFFIX_CHARS,
  COMPLETION_MAX_LINES,
  requestExtrasFor,
  isModelRejection,
  prefixWindow,
  suffixWindow,
  shouldSkipCompletion,
  buildCompletionPrompt,
  buildEditPrompt,
  extractTagged,
  stripFences,
  stripPreamble,
  trimPrefixOverlap,
  trimSuffixOverlap,
  capLines,
  commonIndent,
  reindent,
  cleanCompletion,
  cleanEdit,
};
