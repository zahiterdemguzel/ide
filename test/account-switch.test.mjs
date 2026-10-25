import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWITCH_THRESHOLD, fiveHourUtilization, switchPromptKey, rankSwitchTargets, usageLevel, accountInitials,
  reloginPromptKey,
} from '../src/renderer/shared/account-switch.js';

const view = (fiveHour, resetAt = 1700000000) => ({
  windows: [
    { key: '5h', utilization: fiveHour, resetAt },
    { key: '7d', utilization: 0.2, resetAt: 1800000000 },
  ],
});

test('fiveHourUtilization reads the 5-hour window, null when absent', () => {
  assert.equal(fiveHourUtilization(view(0.4)), 0.4);
  assert.equal(fiveHourUtilization(null), null);
  assert.equal(fiveHourUtilization({ windows: [{ key: '7d', utilization: 1 }] }), null);
});

test('switchPromptKey: asks only at or past 95% of the 5-hour window', () => {
  assert.equal(SWITCH_THRESHOLD, 0.95);
  assert.equal(switchPromptKey('a', view(0.94)), null);
  assert.equal(switchPromptKey('a', view(0.95)), 'a:1700000000');
  assert.equal(switchPromptKey('a', view(1)), 'a:1700000000');
  assert.equal(switchPromptKey('a', null), null);
  assert.equal(switchPromptKey('', view(1)), null);
});

test('switchPromptKey: a new 5-hour window is a new question', () => {
  assert.notEqual(switchPromptKey('a', view(1, 1)), switchPromptKey('a', view(1, 2)));
});

test('rankSwitchTargets: skips the active account, signed-in and emptiest first', () => {
  const accounts = [
    { id: 'active', loggedIn: true },
    { id: 'busy', loggedIn: true },
    { id: 'fresh', loggedIn: true },
    { id: 'unknown', loggedIn: true },
    { id: 'signedOut', loggedIn: false },
  ];
  const usage = { busy: view(0.7), fresh: view(0.1), signedOut: view(0) };
  const ranked = rankSwitchTargets(accounts, usage, 'active').map((r) => r.account.id);
  assert.deepEqual(ranked, ['fresh', 'busy', 'unknown', 'signedOut']);
});

test('usageLevel matches the meter colours', () => {
  assert.equal(usageLevel(0.1), 'ok');
  assert.equal(usageLevel(0.5), 'warn');
  assert.equal(usageLevel(0.8), 'crit');
});

test('accountInitials', () => {
  assert.equal(accountInitials('Work Mail'), 'WM');
  assert.equal(accountInitials('personal'), 'PE');
  assert.equal(accountInitials('  '), '?');
});

test('reloginPromptKey: only an expired login asks, once per login', () => {
  assert.equal(reloginPromptKey({ id: 'a', login: 'ok', loginStamp: 1 }), null);
  assert.equal(reloginPromptKey({ id: 'a', login: 'none' }), null);
  assert.equal(reloginPromptKey(null), null);
  assert.equal(reloginPromptKey({ id: 'a', login: 'expired', loginStamp: 1 }), 'a:1');
  assert.notEqual(reloginPromptKey({ id: 'a', login: 'expired', loginStamp: 2 }), 'a:1');
});
