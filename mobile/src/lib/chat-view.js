// Pure decisions behind the chat screen: how an attached photo is recognised in a
// user message, how much of a big diff a tool card draws up front, when an ask card
// is ready to send, and what a merge-session result means to the reader. Plain JS
// (not TypeScript) so the repo's node:test suite can import it — see
// test/mobile-chat-view.test.mjs.

// An attached image is handed to Claude as a path on a line of its own (see
// src/main/chat.js `save-attachment`), so a user message's text and its attachments
// are one string until they're split apart. Optionally quoted, absolute (POSIX or a
// Windows drive), and an image extension.
const PATH_LINE = /^"?((?:[a-zA-Z]:[\\/]|\/)[^\n]*\.(?:png|jpe?g|gif|webp|heic))"?$/i;

/**
 * Split a user message into what was said and the image paths attached to it.
 * @param {string} text
 * @returns {{ said: string, files: number, paths: string[] }}
 */
export function splitAttachments(text) {
  const said = [];
  const paths = [];
  for (const line of String(text || '').split('\n')) {
    const m = PATH_LINE.exec(line.trim());
    if (m) paths.push(m[1]);
    else said.push(line);
  }
  return { said: said.join('\n').trim(), files: paths.length, paths };
}

// How many diff rows a tool card draws before asking. A Write's diff is the whole
// file, and mapping thousands of rows into the chat froze the JS thread.
export const DIFF_PREVIEW_LINES = 80;
// Each "show more" tap adds this many — enough to read on, bounded so one tap on a
// 10k-line file can't do the same freeze the cap exists to prevent.
export const DIFF_PAGE_LINES = 400;

/**
 * The slice of a diff to draw, and what's left behind the expander.
 * @template T
 * @param {T[]} lines
 * @param {number} limit
 * @returns {{ shown: T[], hidden: number }}
 */
export function capLines(lines, limit) {
  const list = lines || [];
  if (list.length <= limit) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, limit), hidden: list.length - limit };
}

/**
 * The expander's label: "Show all N lines" when one more page reaches the end,
 * otherwise how many the next tap adds.
 * @param {number} hidden
 * @param {number} total
 * @param {number} [page]
 */
export function moreLinesLabel(hidden, total, page = DIFF_PAGE_LINES) {
  if (hidden <= page) return `Show all ${total} lines`;
  return `Show ${page} more lines (${hidden} hidden)`;
}

/**
 * @typedef {{ key?: string, keys?: string[], text?: string }} Answer
 */

/** @param {Answer | undefined} a */
export function isAnswered(a) {
  return Boolean(a && (a.key || a.text || (a.keys && a.keys.length)));
}

/**
 * Every question on the card has an answer — the only state Send is offered in.
 * @param {number} questionCount
 * @param {(Answer | undefined)[]} answers
 */
export function allAnswered(questionCount, answers) {
  if (questionCount < 1) return false;
  for (let i = 0; i < questionCount; i += 1) if (!isAnswered(answers[i])) return false;
  return true;
}

// Refusals main reports as a code rather than raw git output (session-merge.js),
// each naming what the user has to do first. Same wording as the desktop's
// worktree.err* strings.
const MERGE_ERRORS = {
  'detached-main': 'The project has no branch checked out (detached HEAD). Check out a branch, then merge again.',
  'dirty-main': 'The project has uncommitted changes. Commit or stash them, then merge again.',
  'not-ready': 'This worktree is not ready.',
  'not-a-worktree': 'This session has no worktree.',
};

/**
 * What a `merge-session` reply means to the reader.
 * @param {{ ok?: boolean, noop?: boolean, base?: string, branch?: string, code?: string, needsMerge?: boolean, stderr?: string } | null | undefined} r
 * @returns {{ kind: 'merged' | 'noop' | 'conflict' | 'failed', message: string }}
 */
export function mergeOutcome(r) {
  if (r && r.ok) {
    if (r.noop) return { kind: 'noop', message: 'Nothing to merge' };
    return { kind: 'merged', message: r.base ? `Merged into ${r.base}` : 'Merged' };
  }
  if (r && r.needsMerge) {
    return { kind: 'conflict', message: 'The base branch has changes that conflict with this session. Nothing was merged.' };
  }
  const known = r && r.code ? MERGE_ERRORS[/** @type {keyof typeof MERGE_ERRORS} */ (r.code)] : '';
  return { kind: 'failed', message: known || (r && r.stderr) || 'Merge failed' };
}

/**
 * The prompt handed to the session when a merge conflicts: the worktree's own agent
 * wrote the code, so it is best placed to integrate the base branch. Mirrors the
 * desktop's conflict hand-off (git.mergePrompt + worktree.conflictPrompt).
 * @param {{ base?: string, branch?: string, stderr?: string }} r
 */
export function conflictPrompt(r) {
  return [
    "Resolve this git/GitHub problem: pull and push the current branch, resolve any merge conflicts, run the tests, and make sure you don't break any feature.",
    `Merge branch ${r.base || ''} into ${r.branch || ''} in this worktree and resolve the conflicts.`,
    r.stderr || '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Which merge state a worktree session is in, so the bar can say why Merge is off.
 * '' for an ordinary session (no worktree) — it gets Commit/Revert instead.
 * @param {{ worktree?: string, worktreeState?: string } | null | undefined} s
 * @returns {'' | 'ready' | 'missing' | 'pending'}
 */
export function worktreeMode(s) {
  if (!s || !s.worktree) return '';
  if (s.worktreeState === 'missing') return 'missing';
  if (s.worktreeState === 'ready') return 'ready';
  return 'pending';
}
