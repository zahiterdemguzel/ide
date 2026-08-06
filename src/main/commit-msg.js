// Pure (Electron-free) helpers for authoring a commit message from a diff with
// Haiku. Shared by the main git pane (git.js) and the per-session commit
// (session-commit.js) so both phrase the prompt and clean the reply identically.
// Kept here, away from any IPC/PTY, so it stays unit-testable — see
// test/commit-msg.test.js.

// Build the Haiku prompt. Encodes the two widely-used commit standards so the log
// reads professionally rather than as one-line stubs: the Conventional Commits
// 1.0.0 structure (https://www.conventionalcommits.org/en/v1.0.0/) and Chris
// Beams' seven rules of a great commit message (https://cbea.ms/git-commit/). The
// diff is capped so a huge change stays cheap; the model only needs a slice.
function commitMessagePrompt(diff, maxDiff = 12000) {
  return 'Write a professional git commit message for the diff below, following '
    + 'the Conventional Commits specification and the standard seven rules of a '
    + 'great commit message.\n\n'
    + 'Structure:\n'
    + '  <type>(<optional scope>): <subject>\n'
    + '  <blank line>\n'
    + '  <body>\n'
    + '  <blank line>\n'
    + '  <optional footer(s)>\n\n'
    + 'Rules:\n'
    + '- type is one of: feat, fix, docs, style, refactor, perf, test, build, '
    + 'ci, chore, revert. scope is an optional noun naming the area changed, '
    + 'e.g. "feat(git): ...".\n'
    + '- Subject line: imperative mood ("add", not "added"/"adds"), no trailing '
    + 'period, aim for 50 characters and never exceed 72.\n'
    + '- Separate subject from body with a blank line. Write a body whenever the '
    + 'change is non-trivial: explain WHAT changed and WHY (the motivation and '
    + 'effect), not HOW the code does it. Wrap the body at 72 characters and use '
    + '"-" bullets for several distinct changes.\n'
    + '- For a breaking change, append "!" after the type/scope (e.g. '
    + '"feat(api)!: ...") and add a "BREAKING CHANGE: <description>" footer.\n'
    + '- Base the message strictly on the diff — never invent changes.\n\n'
    + 'Reply with ONLY the commit message: no quotes, no code fences, no '
    + 'preamble.\n\n'
    + String(diff || '').slice(0, maxDiff);
}

// Clean a raw model reply into a commit message: strip a wrapping ``` fence or
// surrounding quotes the model sometimes adds despite the instruction, trim, and
// cap the length. Returns '' for an empty/whitespace reply so the caller can fall
// back to a deterministic message.
function cleanCommitMessage(out, maxLen = 4000) {
  let msg = String(out || '').trim();
  if (!msg) return '';
  // A fenced block: drop the opening ```lang line and the closing ``` line.
  if (msg.startsWith('```')) {
    msg = msg.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  // A reply wrapped in matching single/double/back quotes.
  if (msg.length >= 2 && '"\'`'.includes(msg[0]) && msg[msg.length - 1] === msg[0]) {
    msg = msg.slice(1, -1).trim();
  }
  // Local models like to close (and sometimes open) the reply with a markdown
  // horizontal rule — "-----", "=====", "***". It's decoration, not part of the
  // message, and it would land in the git log. Only a line that is ENTIRELY 3+ of
  // the same rule character counts, so a "- bullet" body line is never touched.
  msg = stripRules(msg);
  return msg.slice(0, maxLen);
}

const RULE_LINE = /^\s*([-=_*])\1{2,}\s*$/;
function stripRules(msg) {
  const lines = msg.split('\n');
  // Blank lines around a rule go with it (the model writes "\n\n-----\n"), so keep
  // eating them — a trailing blank run with no rule is dropped by trim() anyway.
  const rubbish = (l) => !l.trim() || RULE_LINE.test(l);
  while (lines.length && rubbish(lines[0])) lines.shift();
  while (lines.length && rubbish(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

// Deterministic message used when Haiku is slow/unavailable: the session's title
// (the 2-4 word Haiku-generated name), else its first prompt's opening line, else
// a stable id-based stub. Capped so a pasted-in first prompt can't bloat the log.
function fallbackCommitMessage({ name, firstPrompt, id } = {}, maxLen = 500) {
  const title = (name || '').trim()
    || ((firstPrompt || '').trim().split('\n')[0] || '').trim()
    || `session ${String(id || '').slice(0, 8)}`;
  return title.slice(0, maxLen);
}

// Choose which downloaded local model authors the commit message, from the
// llama-engine's installed list. Smallest file wins: a commit message is a short,
// easy generation, and the small model both loads and generates fastest — the
// only thing the user notices here is latency. Name breaks size ties so the pick
// is stable. Returns '' when nothing is installed (caller falls back to Haiku).
function pickCommitModel(models) {
  const list = (models || []).filter((m) => m && m.name);
  if (!list.length) return '';
  const best = list.slice().sort((a, b) => (a.size || 0) - (b.size || 0)
    || String(a.name).localeCompare(String(b.name)))[0];
  return best.name;
}

module.exports = {
  commitMessagePrompt, cleanCommitMessage, fallbackCommitMessage, pickCommitModel,
};
