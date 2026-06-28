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
  return msg.slice(0, maxLen);
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

module.exports = { commitMessagePrompt, cleanCommitMessage, fallbackCommitMessage };
