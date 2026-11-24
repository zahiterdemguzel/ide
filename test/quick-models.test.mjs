// The quick-model buttons must point at models the app actually lists, or a click would
// spawn a session on an id main doesn't know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUICK_GPT_MODELS, QUICK_CLAUDE_MODELS, quickModelDragEffort } from '../src/renderer/shared/quick-models.js';

// settings.js touches the DOM on import, so read its model ids from source instead.
const settingsSource = readFileSync(new URL('../src/renderer/settings.js', import.meta.url), 'utf8');
const listedIds = new Set([...settingsSource.matchAll(/\{ id: '([^']+)', name:/g)].map((m) => m[1]));

test('two GPT buttons, all Codex models the app lists', () => {
  assert.equal(QUICK_GPT_MODELS.length, 2);
  assert.equal(QUICK_GPT_MODELS.at(-1).label, 'Astra');
  for (const m of QUICK_GPT_MODELS) {
    assert.ok(m.id.startsWith('codex:'), m.id);
    assert.ok(listedIds.has(m.id), `${m.id} not in CODEX_MODELS`);
  }
});

test('model button drag shifts up to High, down to Low, or stays at Mid', () => {
  for (const [delta, effort] of [[-50, 'high'], [-12, 'high'], [-11, 'medium'], [0, 'medium'], [11, 'medium'], [12, 'low'], [50, 'low']]) {
    assert.equal(quickModelDragEffort(delta), effort, `vertical movement ${delta}px`);
  }
});

test('Claude buttons are Haiku, Sonnet, Opus, Fable and all listed', () => {
  assert.deepEqual(QUICK_CLAUDE_MODELS.map((m) => m.id), ['haiku', 'sonnet', 'opus', 'fable']);
  for (const m of QUICK_CLAUDE_MODELS) assert.ok(listedIds.has(m.id), m.id);
});
