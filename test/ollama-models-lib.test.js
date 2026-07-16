const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isOllamaId, toOllamaId, ollamaName, mergeModels, parsePullProgress, CATALOG, catalogFilter,
  resolvePullTarget, deriveName,
} = require('../src/main/ollama-models-lib');

test('id namespacing round-trips and never collides with Claude aliases', () => {
  assert.equal(toOllamaId('llama3.1:8b'), 'ollama:llama3.1:8b');
  assert.equal(ollamaName('ollama:llama3.1:8b'), 'llama3.1:8b');
  assert.ok(isOllamaId('ollama:mistral'));
  assert.ok(!isOllamaId('opus'));
  assert.ok(!isOllamaId('sonnet'));
  // A bare Claude alias passed to ollamaName is returned untouched.
  assert.equal(ollamaName('opus'), 'opus');
});

test('mergeModels: Claude first, Ollama sorted after, deduped', () => {
  const claude = [{ id: 'default', name: 'Default' }, { id: 'opus', name: 'Opus' }];
  const merged = mergeModels(claude, ['mistral', { name: 'llama3.1:8b' }, 'mistral']);
  assert.deepEqual(merged.map((m) => m.id), ['default', 'opus', 'ollama:llama3.1:8b', 'ollama:mistral']);
  assert.equal(merged[0].ollama, false);
  assert.equal(merged[2].ollama, true);
});

test('parsePullProgress: byte totals become a clamped percent', () => {
  assert.deepEqual(parsePullProgress('{"status":"downloading","total":200,"completed":50}'), { phase: 'downloading', pct: 25, done: false, error: null });
  assert.equal(parsePullProgress({ status: 'success' }).pct, 100);
  assert.equal(parsePullProgress({ status: 'success' }).done, true);
});

test('parsePullProgress: no totals -> null pct; divide-by-zero guarded; malformed -> null', () => {
  assert.equal(parsePullProgress('{"status":"pulling manifest"}').pct, null);
  assert.equal(parsePullProgress({ status: 'x', total: 0, completed: 0 }).pct, null);
  assert.equal(parsePullProgress('not json'), null);
  assert.equal(parsePullProgress(''), null);
});

test('parsePullProgress: an error line is terminal', () => {
  assert.deepEqual(parsePullProgress({ error: 'model not found' }), { phase: 'error', pct: null, done: true, error: 'model not found' });
});

test('CATALOG entries carry numeric RAM/VRAM, a filename-safe name, and a source URI', () => {
  assert.ok(CATALOG.length > 0);
  for (const m of CATALOG) {
    assert.equal(typeof m.name, 'string');
    assert.ok(!/[:/\\]/.test(m.name), `name ${m.name} must be filename-safe`);
    assert.equal(typeof m.minRam, 'number');
    assert.equal(typeof m.minVram, 'number');
    assert.match(m.source, /^(hf:|https?:\/\/)/);
  }
});

test('resolvePullTarget: catalog name -> its source; raw URI -> derived name; unknown -> null', () => {
  const first = CATALOG[0];
  assert.deepEqual(resolvePullTarget(first.name), { source: first.source, name: first.name });
  assert.deepEqual(
    resolvePullTarget('hf:bartowski/Some-Model-GGUF:Q4_K_M'),
    { source: 'hf:bartowski/Some-Model-GGUF:Q4_K_M', name: 'Q4_K_M' },
  );
  assert.equal(resolvePullTarget('https://example.com/path/my-model.gguf').name, 'my-model');
  assert.equal(resolvePullTarget('some-unknown-model'), null);
  assert.equal(resolvePullTarget(''), null);
});

test('deriveName: strips .gguf, keeps filename-safe chars', () => {
  assert.equal(deriveName('https://x/y/Model.Name.gguf'), 'Model.Name');
  assert.equal(deriveName('hf:user/repo:Q8_0'), 'Q8_0');
});

test('catalogFilter: case-insensitive substring; empty query returns all', () => {
  assert.equal(catalogFilter(CATALOG, '').length, CATALOG.length);
  const coder = catalogFilter(CATALOG, 'CODER');
  assert.ok(coder.length > 0);
  assert.ok(coder.every((m) => /coder/i.test(m.name) || /coder/i.test(m.label) || /coder/i.test(m.description)));
  assert.equal(catalogFilter(CATALOG, 'zzznope').length, 0);
});
