import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePrompts, sanitizePromptMap, promptsForProject, withProjectPrompts,
} from '../src/renderer/shared/quick-prompts.js';

const A = '/work/alpha';
const B = '/work/beta';

test('normalizePrompts: trims, drops blanks and duplicates, keeps order', () => {
  assert.deepEqual(
    normalizePrompts(['  Improve this UI ', '', '   ', 'Add tests', 'Improve this UI']),
    ['Improve this UI', 'Add tests'],
  );
});

test('normalizePrompts: ignores non-strings and non-arrays', () => {
  assert.deepEqual(normalizePrompts(['ok', 3, null, {}]), ['ok']);
  assert.deepEqual(normalizePrompts('nope'), []);
  assert.deepEqual(normalizePrompts(undefined), []);
});

test('sanitizePromptMap: keeps valid entries and cleans their lists', () => {
  assert.deepEqual(sanitizePromptMap({ [A]: [' x ', 'x', 'y'] }), { [A]: ['x', 'y'] });
});

// The file is hand-editable and outlives version changes, so anything shaped
// wrong must degrade to "no prompts" rather than throw on load.
test('sanitizePromptMap: rejects wrong shapes and empty entries', () => {
  assert.deepEqual(sanitizePromptMap(null), {});
  assert.deepEqual(sanitizePromptMap([1]), {});
  assert.deepEqual(sanitizePromptMap('x'), {});
  assert.deepEqual(sanitizePromptMap({ [A]: 'x', [B]: [] }), {});
  assert.deepEqual(sanitizePromptMap({ '': ['x'] }), {});
});

test('promptsForProject: returns a copy, empty for unknown projects', () => {
  const map = { [A]: ['x'] };
  const list = promptsForProject(map, A);
  list.push('y');
  assert.deepEqual(map[A], ['x']);
  assert.deepEqual(promptsForProject(map, B), []);
  assert.deepEqual(promptsForProject(null, A), []);
  assert.deepEqual(promptsForProject(map, null), []);
});

test('withProjectPrompts: sets one project without touching others or the input', () => {
  const map = { [B]: ['b'] };
  const next = withProjectPrompts(map, A, ['a', ' a ']);
  assert.deepEqual(next, { [A]: ['a'], [B]: ['b'] });
  assert.deepEqual(map, { [B]: ['b'] });
});

test('withProjectPrompts: an emptied list drops the project', () => {
  assert.deepEqual(withProjectPrompts({ [A]: ['a'] }, A, ['', '  ']), {});
});

test('withProjectPrompts: no project is a no-op copy', () => {
  assert.deepEqual(withProjectPrompts({ [A]: ['a'] }, '', ['x']), { [A]: ['a'] });
});
