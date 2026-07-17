const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelFamily, canSwitchModel, isCodexId, codexModelName, codexSpawnArgs, codexHookCommand, CODEX_HOOK_EVENTS } = require('../src/main/agent-providers');

test('model ids resolve to their CLI family by prefix', () => {
  assert.equal(modelFamily('codex:gpt-5.5'), 'codex');
  assert.equal(modelFamily('ollama:llama3.1:8b'), 'ollama');
  assert.equal(modelFamily('opus'), 'claude');
  assert.equal(modelFamily('default'), 'claude');
  assert.equal(modelFamily(''), 'claude');
  assert.equal(modelFamily(undefined), 'claude');
});

test('codex id helpers strip the prefix and only the prefix', () => {
  assert.equal(isCodexId('codex:gpt-5.5'), true);
  assert.equal(isCodexId('gpt-5.5'), false);
  assert.equal(codexModelName('codex:gpt-5.4-mini'), 'gpt-5.4-mini');
  assert.equal(codexModelName('opus'), 'opus');
});

test('a session may only switch models within its family', () => {
  assert.equal(canSwitchModel('opus', 'sonnet'), true);
  assert.equal(canSwitchModel('default', 'haiku'), true);
  assert.equal(canSwitchModel('codex:gpt-5.5', 'codex:gpt-5.4'), true);
});

test('cross-family and ollama switches are rejected', () => {
  assert.equal(canSwitchModel('opus', 'codex:gpt-5.5'), false);
  assert.equal(canSwitchModel('codex:gpt-5.5', 'opus'), false);
  assert.equal(canSwitchModel('codex:gpt-5.5', 'ollama:llama3'), false);
  // Local models are frozen for life — even to another local model.
  assert.equal(canSwitchModel('ollama:llama3', 'ollama:qwen'), false);
  assert.equal(canSwitchModel('opus', 'ollama:llama3'), false);
});

test('codex spawn argv: model, effort override, hooks, trust bypass', () => {
  const args = codexSpawnArgs({
    resume: false, agentSessionId: '', model: 'codex:gpt-5.5', effort: 'xhigh',
    port: 4567, ideId: 'IDE-1', platform: 'linux',
  });
  assert.deepEqual(args.slice(0, 2), ['--model', 'gpt-5.5']);
  assert.deepEqual(args.slice(2, 4), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.equal(args[args.length - 1], '--dangerously-bypass-hook-trust');
  // One -c override per hook event, each posting to our server tagged with the IDE id.
  for (const ev of CODEX_HOOK_EVENTS) {
    const override = args.find((a) => a.startsWith(`hooks.${ev}=`));
    assert.ok(override, `missing hook override for ${ev}`);
    assert.match(override, /curl -s -X POST 'http:\/\/127\.0\.0\.1:4567\/hook\?ide=IDE-1' -d @-/);
  }
});

test('codex resume prepends the recorded agent session id', () => {
  const args = codexSpawnArgs({
    resume: true, agentSessionId: 'abc-123', model: 'codex:gpt-5.5', effort: '',
    port: 1, ideId: 'x', platform: 'linux',
  });
  assert.deepEqual(args.slice(0, 2), ['resume', 'abc-123']);
});

test('codex resume without a recorded agent id starts fresh instead', () => {
  const args = codexSpawnArgs({
    resume: true, agentSessionId: '', model: 'codex:gpt-5.5', effort: '',
    port: 1, ideId: 'x', platform: 'linux',
  });
  assert.notEqual(args[0], 'resume');
});

test('unknown codex effort adds no override; claude-only max is unknown to codex', () => {
  const args = codexSpawnArgs({
    resume: false, agentSessionId: '', model: 'codex:gpt-5.5', effort: 'max',
    port: 1, ideId: 'x', platform: 'linux',
  });
  assert.ok(!args.some((a) => a.includes('model_reasoning_effort')));
});

test('windows hook command names curl.exe and quotes @- (PowerShell)', () => {
  const cmd = codexHookCommand(9999, 'ID', 'win32');
  assert.equal(cmd, "curl.exe -s -X POST 'http://127.0.0.1:9999/hook?ide=ID' -d '@-'");
});
