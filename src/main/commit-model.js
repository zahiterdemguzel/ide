// Model selection for both commit-message generation paths.
const { runHaiku, runCli } = require('./claude');
const { readStore } = require('./settings-store');
const { pickCommitModel } = require('./commit-msg');
const { isChatgptId, chatgptFamilyName, chatgptSpawnEnv, chatgptIdForNewSession } = require('./provider-accounts-lib');

async function runLocal(prompt, name) {
  const eng = require('./llama-engine');
  const selected = name || pickCommitModel(await eng.listInstalled());
  if (!selected) return null;
  const res = await eng.chat({ model: selected, messages: [{ role: 'user', content: prompt }] });
  return res?.message?.content || null;
}

// GPT through Claude Code: the claude CLI against the account proxy's ChatGPT route.
async function runChatgpt(prompt, model) {
  const { ensureAccountProxy } = require('./account-proxy'); // lazy: keeps the proxy out of startup for non-GPT users
  const port = await ensureAccountProxy();
  if (!port) return null;
  return runCli(prompt, { model: chatgptFamilyName(model), envOverrides: chatgptSpawnEnv({ port, model }) });
}

async function runCommitModel(prompt) {
  // A commit model saved back when GPT ran on the Codex CLI now runs through Claude Code too.
  const selected = chatgptIdForNewSession((readStore() || {})['ide.commitModel'] || 'auto');
  try {
    if (selected.startsWith('ollama:')) return await runLocal(prompt, selected.slice(7));
    if (isChatgptId(selected)) return await runChatgpt(prompt, selected);
    if (selected !== 'auto') return selected === 'haiku' ? await runHaiku(prompt) : await runCli(prompt, { model: selected });
    const out = await runLocal(prompt);
    if (out?.trim()) return out;
  } catch (err) {
    console.error('[commit-msg] model failed:', err && err.message);
    if (selected !== 'auto') return null;
  }
  return runHaiku(prompt);
}

module.exports = { runCommitModel };
