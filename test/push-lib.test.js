const { test } = require('node:test');
const assert = require('node:assert');
const { isExpoPushToken, buildPushMessages, tokensToDrop, withPushToken } = require('../src/main/push-lib');

const TOK = 'ExponentPushToken[abc123]';
const TOK2 = 'ExpoPushToken[def456]';

test('isExpoPushToken accepts both Expo token forms, rejects everything else', () => {
  assert.ok(isExpoPushToken(TOK));
  assert.ok(isExpoPushToken(TOK2));
  assert.ok(!isExpoPushToken('abc'));
  assert.ok(!isExpoPushToken('ExponentPushToken[]'));
  assert.ok(!isExpoPushToken(null));
  assert.ok(!isExpoPushToken(42));
});

test('buildPushMessages targets only devices with a token', () => {
  const devices = [
    { id: 'a', pushToken: TOK },
    { id: 'b' },
    { id: 'c', pushToken: 'garbage' },
  ];
  const msgs = buildPushMessages(devices, { title: 'T', body: 'B', data: { sessionId: 's1' } });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].to, TOK);
  assert.equal(msgs[0].title, 'T');
  assert.deepEqual(msgs[0].data, { sessionId: 's1' });
});

test('buildPushMessages handles empty/missing device list', () => {
  assert.deepEqual(buildPushMessages([], { title: 't' }), []);
  assert.deepEqual(buildPushMessages(undefined, { title: 't' }), []);
});

test('tokensToDrop picks DeviceNotRegistered tickets by position', () => {
  const msgs = [{ to: TOK }, { to: TOK2 }];
  const tickets = [
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'ok' },
  ];
  assert.deepEqual(tokensToDrop(msgs, tickets), [TOK]);
  assert.deepEqual(tokensToDrop(msgs, null), []);
  assert.deepEqual(tokensToDrop(msgs, [{ status: 'error' }]), []);
});

test('withPushToken sets, replaces, clears, and reports no-ops', () => {
  const devices = [{ id: 'a', name: 'Phone' }, { id: 'b', pushToken: TOK2 }];
  const set = withPushToken(devices, 'a', TOK);
  assert.equal(set[0].pushToken, TOK);
  assert.equal(devices[0].pushToken, undefined); // input untouched
  const cleared = withPushToken(devices, 'b', null);
  assert.ok(!('pushToken' in cleared[1]));
  assert.equal(withPushToken(devices, 'b', TOK2), null); // same token: no write
  assert.equal(withPushToken(devices, 'a', null), null); // already absent: no write
  assert.equal(withPushToken(devices, 'nope', TOK), null); // unknown device
});
