// Which model authors an auto-generated commit message. Prefers a *local* GGUF
// the user has already downloaded through Settings → Custom models: it costs no
// subscription usage and needs no network, and a commit message is a small enough
// generation that a small local model handles it well. Falls back to Haiku when
// nothing is installed or the local run fails/returns nothing.
//
// Shared by both auto-generation call sites — the git pane's Commit button
// (git.js) and the per-session commit (session-commit.js).

const { runHaiku } = require('./claude');
const { pickCommitModel } = require('./commit-msg');

// llama-engine pulls in node-llama-cpp; require it lazily so a user who never
// downloaded a model doesn't pay for loading it on every commit.
function engine() { return require('./llama-engine'); }

async function runLocal(prompt) {
  const eng = engine();
  const name = pickCommitModel(await eng.listInstalled());
  if (!name) return null;
  const res = await eng.chat({
    model: name,
    messages: [{ role: 'user', content: prompt }],
  });
  return (res && res.message && res.message.content) || null;
}

// Generate a commit message from `prompt` (built by commitMessagePrompt). Returns
// the raw model text, or null when every path failed — the caller cleans it and
// decides on its own fallback.
async function runCommitModel(prompt) {
  try {
    const out = await runLocal(prompt);
    if (out && out.trim()) return out;
  } catch (err) {
    console.error('[commit-msg] local model failed, falling back to Haiku:', err && err.message);
  }
  return runHaiku(prompt);
}

module.exports = { runCommitModel };
