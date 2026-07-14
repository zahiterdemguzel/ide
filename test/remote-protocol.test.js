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
  // A phone's terminal is destroyed whenever it leaves the session screen, so it has
  // to be able to fetch the scrollback main retained and replay it.
  assert.equal(proto.canCall('req', 'session-scrollback'), true);
  // A phone pages its session list rather than holding the whole archive.
  assert.equal(proto.canCall('req', 'query-sessions'), true);
  assert.equal(proto.canCall('req', 'open-folder'), false); // native dialog stays desktop-only
  assert.equal(proto.canCall('req', 'db-open'), false);
  // A phone claims a session while its terminal screen is open so the desktop covers it.
  assert.equal(proto.canCall('send', 'session-control'), true);
  // Run panel: list the .vscode configs, start/stop one, and attach to the terminal
  // it opened (list + retained output).
  assert.equal(proto.canCall('req', 'get-run-configs'), true);
  assert.equal(proto.canCall('req', 'run-config-start'), true);
  assert.equal(proto.canCall('req', 'run-config-stop'), true);
  assert.equal(proto.canCall('req', 'term-list'), true);
  assert.equal(proto.canCall('req', 'term-scrollback'), true);
  // `run-config` only resolves specs for the caller to run — a phone can't open a
  // terminal tab, so it goes through run-config-start (which routes to the desktop).
  assert.equal(proto.canCall('req', 'run-config'), false);
  assert.equal(proto.canCall('send', 'get-repo-path'), false); // wrong kind
  assert.equal(proto.canCall('bogus', 'get-repo-path'), false);
});

test('remote events filter', () => {
  assert.equal(proto.isRemoteEvent('folder-changed'), true);
  // The session list is pushed on every create/archive/restore/delete so a phone
  // stays in sync with the desktop (and with another phone).
  assert.equal(proto.isRemoteEvent('sessions-changed'), true);
  // Open/closed terminals are pushed too — that's how a phone knows which launch
  // configs are running, since a config runs for as long as its terminal is open.
  assert.equal(proto.isRemoteEvent('terminals-changed'), true);
  assert.equal(proto.isRemoteEvent('select-session'), false);
  // Specs for a phone-requested run go to the desktop renderer only — never back
  // out to the phone that asked.
  assert.equal(proto.isRemoteEvent('run-specs'), false);
});

test('message builders round-trip through parse where applicable', () => {
  assert.equal(proto.hello().protoVersion, proto.PROTO_VERSION);
  assert.deepEqual(proto.resOk(3, [1]), { t: 'res', id: 3, ok: true, result: [1] });
  assert.deepEqual(proto.resErr(3, 'boom'), { t: 'res', id: 3, ok: false, error: 'boom' });
  assert.deepEqual(proto.ev('folder-changed', { repo: 'x' }), { t: 'ev', ch: 'folder-changed', payload: { repo: 'x' } });
});
