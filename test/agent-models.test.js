const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelEnv } = require('../src/main/agent-models');

test('modelEnv: sets both vars for explicit model selections', () => {
  assert.deepEqual(
    modelEnv({ model: 'opus', subagentModel: 'haiku' }),
    { ANTHROPIC_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' },
  );
});

test('modelEnv: the "default" sentinel sets no var (CLI resolves normally)', () => {
  assert.deepEqual(modelEnv({ model: 'default', subagentModel: 'default' }), {});
});

test('modelEnv: only the chosen halves are set', () => {
  assert.deepEqual(modelEnv({ model: 'default', subagentModel: 'sonnet' }), {
    CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet',
  });
  assert.deepEqual(modelEnv({ model: 'opus' }), { ANTHROPIC_MODEL: 'opus' });
});

test('modelEnv: trims and ignores empty / missing selections', () => {
  assert.deepEqual(modelEnv({ model: '  opus  ', subagentModel: '' }), { ANTHROPIC_MODEL: 'opus' });
  assert.deepEqual(modelEnv({}), {});
  assert.deepEqual(modelEnv(), {});
});

test('modelEnv: passes a full model id through verbatim', () => {
  assert.deepEqual(modelEnv({ model: 'claude-opus-4-8' }), { ANTHROPIC_MODEL: 'claude-opus-4-8' });
});
