const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseScopes, scopeEnabled, redact, formatLine, createDebug,
} = require('../server/debug');

const AT = Date.UTC(2026, 0, 1, 12, 30, 45, 123);
const capture = (env) => {
  const lines = [];
  const { debugFor, enabled } = createDebug({ env, sink: (l) => lines.push(l), now: () => AT });
  return { lines, debugFor, enabled };
};

test('parseScopes splits on commas and whitespace, ignoring blanks', () => {
  assert.deepEqual(parseScopes('hub, relay'), ['hub', 'relay']);
  assert.deepEqual(parseScopes(''), []);
  assert.deepEqual(parseScopes(undefined), []);
});

test('a namespace is off unless a scope names it', () => {
  assert.equal(scopeEnabled(parseScopes('hub'), 'hub'), true);
  assert.equal(scopeEnabled(parseScopes('hub'), 'relay'), false);
  assert.equal(scopeEnabled([], 'hub'), false);
});

test('1/true/* all mean every namespace', () => {
  for (const value of ['1', 'true', '*']) {
    assert.equal(scopeEnabled(parseScopes(value), 'tunnel'), true, value);
  }
});

// The tunnel namespace logs a line per byte chunk, so excluding it is the
// difference between a readable trace and a wall of noise.
test('a later negation excludes a namespace the wildcard let in', () => {
  const scopes = parseScopes('*,-tunnel');
  assert.equal(scopeEnabled(scopes, 'hub'), true);
  assert.equal(scopeEnabled(scopes, 'tunnel'), false);
});

test('redact drops credential-named fields at any depth', () => {
  assert.deepEqual(
    redact({ deviceToken: 'secretvalue', d: { pairToken: 'x', ch: 'git-status' } }),
    { deviceToken: '***', d: { pairToken: '***', ch: 'git-status' } },
  );
});

test('redact caps long strings and summarizes buffers', () => {
  const long = 'a'.repeat(200);
  assert.equal(redact(long), `${'a'.repeat(120)}…+80`);
  assert.equal(redact(Buffer.alloc(42)), '<42b>');
});

test('formatLine renders time, namespace, message and fields', () => {
  assert.equal(
    formatLine('12:30:45.123', 'hub', 'req ok', { ch: 'git-status', ms: 12 }),
    '12:30:45.123 [hub] req ok ch=git-status ms=12',
  );
  assert.equal(formatLine('12:30:45.123', 'relay', 'listening'), '12:30:45.123 [relay] listening');
});

// One field set per message shape, so an `id`-less frame would otherwise trail
// `id=undefined` on every line.
test('formatLine omits absent fields and quotes strings that need it', () => {
  assert.equal(
    formatLine('12:30:45.123', 'hub', 'rx', { t: 'send', ch: 'pty-input', id: undefined }),
    '12:30:45.123 [hub] rx t=send ch=pty-input',
  );
  assert.equal(
    formatLine('12:30:45.123', 'route', 'deny', { target: '/a b' }),
    '12:30:45.123 [route] deny target="/a b"',
  );
});

test('a disabled namespace emits nothing and reports off', () => {
  const { lines, debugFor } = capture({});
  const log = debugFor('hub');
  log('req ok', { ch: 'git-status' });
  assert.equal(log.on, false);
  assert.deepEqual(lines, []);
});

test('an enabled namespace emits one timestamped line per call', () => {
  const { lines, debugFor, enabled } = capture({ IDE_DEBUG: 'hub' });
  assert.equal(enabled, true);
  debugFor('hub')('paired', { device: 'd1', deviceToken: 'nope' });
  debugFor('relay')('client joined', { room: 'r1' });
  assert.deepEqual(lines, ['12:30:45.123 [hub] paired device=d1 deviceToken=***']);
});
