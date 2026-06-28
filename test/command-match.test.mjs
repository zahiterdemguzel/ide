import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCommands } from '../src/renderer/shared/command-match.js';

const CMDS = [
  { id: 'new-session', title: 'New Session', keywords: 'create terminal claude' },
  { id: 'go-to-file', title: 'Go to File', keywords: 'quick open search' },
  { id: 'open-settings', title: 'Settings', keywords: 'preferences theme language' },
];

test('matchCommands: empty query returns every command in order, unscored', () => {
  const out = matchCommands('', CMDS);
  assert.deepEqual(out.map((r) => r.command.id), ['new-session', 'go-to-file', 'open-settings']);
  assert.ok(out.every((r) => r.positions.length === 0));
});

test('matchCommands: matches against the visible title and returns positions', () => {
  const out = matchCommands('sess', CMDS);
  assert.equal(out[0].command.id, 'new-session');
  assert.ok(out[0].positions.length > 0); // title hit is highlightable
});

test('matchCommands: falls back to hidden keywords when the title misses', () => {
  const out = matchCommands('preferences', CMDS);
  assert.equal(out[0].command.id, 'open-settings');
  assert.deepEqual(out[0].positions, []); // keyword-only matches are not highlighted
});

test('matchCommands: a title match outranks a keyword-only match', () => {
  // "open" is in the "Go to File" keywords but is the literal title word path for
  // none; both "Go to File" (keyword) and "Settings" miss the title, so add a case
  // where one command matches by title and another only by keyword.
  const cmds = [
    { id: 'a', title: 'Reload Theme', keywords: '' },
    { id: 'b', title: 'Settings', keywords: 'theme' },
  ];
  const out = matchCommands('theme', cmds);
  assert.equal(out[0].command.id, 'a'); // title hit beats keyword hit
  assert.equal(out[1].command.id, 'b');
});

test('matchCommands: drops non-matches and respects the limit', () => {
  const out = matchCommands('go', CMDS, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].command.id, 'go-to-file');
});

test('matchCommands: a query matching nothing returns empty', () => {
  assert.deepEqual(matchCommands('zzzzz', CMDS), []);
});
