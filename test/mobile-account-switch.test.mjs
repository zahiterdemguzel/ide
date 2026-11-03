// The phone's "switch account?" suggestion (mobile/src/lib/account-switch.js), pinned
// to the desktop's 95% prompt rules (src/renderer/shared/account-switch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWITCH_THRESHOLD, switchSuggestionKey, switchTargets, suggestSwitch,
} from '../mobile/src/lib/account-switch.js';
import * as desktop from '../src/renderer/shared/account-switch.js';

const view = (util, resetAt = 1000) => ({ windows: [{ key: '5h', utilization: util, resetAt }] });
const accounts = [
  { id: 'a', name: 'Work', loggedIn: true, login: 'ok' },
  { id: 'b', name: 'Home', loggedIn: true, login: 'ok' },
  { id: 'c', name: 'Old', loggedIn: false, login: 'expired' },
  { id: 'd', name: 'Spare', loggedIn: true, login: 'ok' },
];

test('threshold and key match the desktop prompt', () => {
  assert.equal(SWITCH_THRESHOLD, desktop.SWITCH_THRESHOLD);
  for (const util of [0.5, 0.949, 0.95, 1]) {
    assert.equal(switchSuggestionKey('a', view(util)), desktop.switchPromptKey('a', view(util)));
  }
  assert.equal(switchSuggestionKey(null, view(1)), null);
});

test('targets are the signed-in others, ranked like the desktop', () => {
  const usage = { b: view(0.7), d: view(0.2) };
  const ours = switchTargets(accounts, usage, 'a').map((t) => t.account.id);
  const theirs = desktop.rankSwitchTargets(accounts, usage, 'a')
    .filter((t) => t.account.loggedIn).map((t) => t.account.id);
  assert.deepEqual(ours, theirs);
  assert.deepEqual(ours, ['d', 'b']);
});

test('unknown usage ranks after known', () => {
  assert.deepEqual(switchTargets(accounts, { b: view(0.9) }, 'a').map((t) => t.account.id), ['b', 'd']);
});

test('suggests the best target only past the threshold', () => {
  assert.equal(suggestSwitch({ activeId: 'a', accounts, view: view(0.5) }), null);
  const s = suggestSwitch({ activeId: 'a', accounts, view: view(0.97), usageById: { b: view(0.1), d: view(0.6) } });
  assert.deepEqual(s, { key: 'a:1000', target: accounts[1] });
});

test('never suggests an expired login or a target that is nearly full itself', () => {
  const onlyExpired = [accounts[0], accounts[2]];
  assert.equal(suggestSwitch({ activeId: 'a', accounts: onlyExpired, view: view(0.99) }), null);
  const full = { b: view(0.96), d: view(0.99) };
  assert.equal(suggestSwitch({ activeId: 'a', accounts, view: view(0.99), usageById: full }), null);
});
