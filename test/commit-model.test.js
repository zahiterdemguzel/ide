const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(selected, localFails = false) {
  const calls = [];
  const modules = {
    child_process: { execFile: (_exe, args, _opts, cb) => {
      calls.push(['codex', args]);
      return { stdin: { on() {}, end(prompt) { calls.push(['prompt', prompt]); cb(null, 'codex result'); } } };
    } },
    os: { tmpdir: () => '/tmp' },
    './claude': { runHaiku: async () => { calls.push(['haiku']); return 'haiku result'; }, runCli: async (_p, opts) => { calls.push(['claude', opts.model]); return 'claude result'; } },
    './codex': { resolveCodex: async () => 'codex' },
    './settings-store': { readStore: () => ({ 'ide.commitModel': selected }) },
    './commit-msg': { pickCommitModel: () => 'small' },
    './llama-engine': { listInstalled: async () => [{ name: 'small' }], chat: async (opts) => { calls.push(['local', opts.model]); if (localFails) throw Error('failed'); return { message: { content: 'local result' } }; } },
  };
  const context = { require: (id) => modules[id], module: { exports: {} }, console: { error() {} }, process: { platform: 'linux' } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/main/commit-model'), 'utf8'), context);
  return { run: context.module.exports.runCommitModel, calls };
}

test('commit model routes explicit selections to the chosen provider', async () => {
  for (const [id, expected, result] of [['ollama:my-model', 'local', 'local result'], ['sonnet', 'claude', 'claude result'], ['haiku', 'haiku', 'haiku result'], ['codex:gpt-6-luna', 'codex', 'codex result']]) {
    const h = harness(id);
    assert.equal(await h.run('diff'), result);
    assert.equal(h.calls[0][0], expected);
    if (id === 'ollama:my-model') assert.equal(h.calls[0][1], 'my-model');
    if (id === 'sonnet') assert.equal(h.calls[0][1], 'sonnet');
    if (id.startsWith('codex:')) assert.ok(h.calls[0][1].includes('gpt-6-luna'));
  }
});

test('automatic selection falls back to Haiku, explicit local selection does not', async () => {
  const auto = harness('auto', true);
  assert.equal(await auto.run('diff'), 'haiku result');
  const explicit = harness('ollama:missing', true);
  assert.equal(await explicit.run('diff'), null);
  assert.equal(explicit.calls.length, 1);
});
