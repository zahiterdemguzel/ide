const { test } = require('node:test');
const assert = require('node:assert');
const proto = require('../server/protocol');

test('parseMessage rejects garbage and wrong shapes', () => {
  assert.equal(proto.parseMessage('not json'), null);
  assert.equal(proto.parseMessage('42'), null);
  assert.equal(proto.parseMessage('null'), null);
  assert.equal(proto.parseMessage(JSON.stringify({ t: 'nope' })), null);
  assert.equal(proto.parseMessage(JSON.stringify({ t: 'pair' })), null);
  assert.equal(proto.parseMessage(JSON.stringify({ t: 'auth' })), null);
  assert.equal(proto.parseMessage(JSON.stringify({ t: 'req', ch: 'x' })), null); // missing id
  assert.equal(proto.parseMessage(JSON.stringify({ t: 'send' })), null); // missing ch
});

test('parseMessage accepts valid messages', () => {
  assert.deepEqual(
    proto.parseMessage(JSON.stringify({ t: 'pair', pairToken: 'tk', deviceName: 'phone' })),
    { t: 'pair', pairToken: 'tk', deviceName: 'phone' });
  assert.ok(proto.parseMessage(JSON.stringify({ t: 'auth', deviceToken: 'dt' })));
  assert.ok(proto.parseMessage(JSON.stringify({ t: 'req', id: 1, ch: 'get-repo-path' })));
  assert.ok(proto.parseMessage(JSON.stringify({ t: 'req', id: 'a1', ch: 'x', args: { y: 1 } })));
  assert.ok(proto.parseMessage(JSON.stringify({ t: 'send', ch: 'pty-input', args: 'hi' })));
});

test('allowlist gates channels', () => {
  assert.equal(proto.canCall('req', 'get-recent-folders'), true);
  assert.equal(proto.canCall('req', 'open-folder'), false); // native dialog stays desktop-only
  assert.equal(proto.canCall('req', 'db-open'), false);
  assert.equal(proto.canCall('send', 'get-repo-path'), false); // wrong kind
  assert.equal(proto.canCall('bogus', 'get-repo-path'), false);
});

test('remote events filter', () => {
  assert.equal(proto.isRemoteEvent('folder-changed'), true);
  assert.equal(proto.isRemoteEvent('select-session'), false);
});

test('message builders round-trip through parse where applicable', () => {
  assert.equal(proto.hello().protoVersion, proto.PROTO_VERSION);
  assert.deepEqual(proto.resOk(3, [1]), { t: 'res', id: 3, ok: true, result: [1] });
  assert.deepEqual(proto.resErr(3, 'boom'), { t: 'res', id: 3, ok: false, error: 'boom' });
  assert.deepEqual(proto.ev('folder-changed', { repo: 'x' }), { t: 'ev', ch: 'folder-changed', payload: { repo: 'x' } });
});
