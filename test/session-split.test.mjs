import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSplitSession, splitAfterClick, splitPartner, splitStillValid } from '../src/renderer/shared/session-split.js';

const all = () => true;

test('only live, non-worktree sessions can be split', () => {
  assert.equal(canSplitSession({ worktree: '', archived: false }), true);
  assert.equal(canSplitSession({ worktree: '/repo/.claude/worktrees/x', archived: false }), false);
  assert.equal(canSplitSession({ worktree: '', archived: true }), false);
  assert.equal(canSplitSession(undefined), false);
});

test('shift+click opens the clicked session beside the active one', () => {
  assert.deepEqual(splitAfterClick({ split: null, activeId: 'a', clickedId: 'b', shift: true, eligible: all }), ['a', 'b']);
});

test('a plain click on another session returns to a single terminal', () => {
  assert.equal(splitAfterClick({ split: ['a', 'b'], activeId: 'a', clickedId: 'c', shift: false, eligible: all }), null);
  assert.equal(splitAfterClick({ split: null, activeId: 'a', clickedId: 'b', shift: false, eligible: all }), null);
});

test('clicking a session already on screen keeps the split', () => {
  const split = ['a', 'b'];
  assert.equal(splitAfterClick({ split, activeId: 'a', clickedId: 'b', shift: false, eligible: all }), split);
  assert.equal(splitAfterClick({ split, activeId: 'a', clickedId: 'a', shift: true, eligible: all }), split);
});

test('shift+click a third session replaces the unfocused pane', () => {
  assert.deepEqual(splitAfterClick({ split: ['a', 'b'], activeId: 'b', clickedId: 'c', shift: true, eligible: all }), ['c', 'b']);
  assert.deepEqual(splitAfterClick({ split: ['a', 'b'], activeId: 'a', clickedId: 'c', shift: true, eligible: all }), ['a', 'c']);
});

test('shift+click that cannot split behaves like a plain click', () => {
  const noWorktree = (id) => id !== 'wt';
  assert.equal(splitAfterClick({ split: null, activeId: 'a', clickedId: 'wt', shift: true, eligible: noWorktree }), null);
  assert.equal(splitAfterClick({ split: null, activeId: 'wt', clickedId: 'a', shift: true, eligible: noWorktree }), null);
  assert.equal(splitAfterClick({ split: null, activeId: null, clickedId: 'a', shift: true, eligible: all }), null);
  assert.equal(splitAfterClick({ split: null, activeId: 'a', clickedId: 'a', shift: true, eligible: all }), null);
});

test('splitPartner names the other pane', () => {
  assert.equal(splitPartner(['a', 'b'], 'a'), 'b');
  assert.equal(splitPartner(['a', 'b'], 'b'), 'a');
  assert.equal(splitPartner(['a', 'b'], 'c'), null);
  assert.equal(splitPartner(null, 'a'), null);
});

test('the split breaks when focus leaves it or a pane becomes ineligible', () => {
  assert.equal(splitStillValid(['a', 'b'], 'a', all), true);
  assert.equal(splitStillValid(['a', 'b'], 'c', all), false);
  assert.equal(splitStillValid(['a', 'b'], 'a', (id) => id !== 'b'), false);
  assert.equal(splitStillValid(null, 'a', all), false);
});
