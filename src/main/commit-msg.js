// Pure (Electron-free) helpers for authoring a commit message from a diff with
// Haiku. Shared by the main git pane (git.js) and the per-session commit
// (session-commit.js) so both phrase the prompt and clean the reply identically.
// Kept here, away from any IPC/PTY, so it stays unit-testable — see
// test/commit-msg.test.js.

// Build the Haiku prompt. The diff is capped so a huge change stays cheap; the
// model only needs a representative slice to write a subject + short body.
function commitMessagePrompt(diff, maxDiff = 12000) {
  return 'Write a git commit message for the diff below: a concise '
    + 'imperative subject line, then an optional body. Reply with ONLY the '
    + 'message — no quotes, no code fences, no preamble.\n\n'
    + String(diff || '').slice(0, maxDiff);
}

// Clean a raw model reply into a commit message: strip a wrapping ``` fence or
// surrounding quotes the model sometimes adds despite the instruction, trim, and
// cap the length. Returns '' for an empty/whitespace reply so the caller can fall
// back to a deterministic message.
function cleanCommitMessage(out, maxLen = 1000) {
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
