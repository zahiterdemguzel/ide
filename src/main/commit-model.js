// Model selection for both commit-message generation paths.
const { execFile } = require('child_process');
const os = require('os');
const { runHaiku, runCli } = require('./claude');
const { resolveCodex } = require('./codex');
const { readStore } = require('./settings-store');
const { pickCommitModel } = require('./commit-msg');

async function runLocal(prompt, name) {
  const eng = require('./llama-engine');
  const selected = name || pickCommitModel(await eng.listInstalled());
  if (!selected) return null;
  const res = await eng.chat({ model: selected, messages: [{ role: 'user', content: prompt }] });
  return res?.message?.content || null;
}

async function runCodex(prompt, model) {
  const exe = await resolveCodex();
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', model, '-'];
    // The model comes from the settings menu; never interpolate it into shell syntax.
    if (win32 && !/^[\w.-]+$/.test(model)) return resolve(null);
    const child = execFile(win32 ? `"${exe}"` : exe, win32 ? args.map((a) => `"${a}"`) : args,
      { cwd: os.tmpdir(), shell: win32, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function runCommitModel(prompt) {
  const selected = (readStore() || {})['ide.commitModel'] || 'auto';
  try {
    if (selected.startsWith('ollama:')) return await runLocal(prompt, selected.slice(7));
    if (selected.startsWith('codex:')) return await runCodex(prompt, selected.slice(6));
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
