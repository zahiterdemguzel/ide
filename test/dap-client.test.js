const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { DapClient } = require('../src/main/dap-client');
const { createDapReader, encodeDapMessage } = require('../src/main/debug-lib');

// A fake adapter: what the client writes arrives in `sent`; `reply` feeds the client.
function harness() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const sent = [];
  const reader = createDapReader((m) => sent.push(m));
  fromClient.on('data', (c) => reader.push(c));
  const client = new DapClient().connect(toClient, fromClient);
  const reply = (msg) => toClient.write(encodeDapMessage(msg));
  const tick = () => new Promise((r) => setImmediate(r));
  return { client, sent, reply, tick, toClient };
}

test('request resolves with the matching response body', async () => {
  const { client, sent, reply, tick } = harness();
  const p1 = client.request('threads', {});
  const p2 = client.request('scopes', { frameId: 4 });
  await tick();
  assert.deepEqual(sent.map((m) => [m.type, m.command, m.seq]), [['request', 'threads', 1], ['request', 'scopes', 2]]);
  // Answered out of order: each lands on its own request.
  reply({ seq: 10, type: 'response', request_seq: 2, command: 'scopes', success: true, body: { scopes: ['s'] } });
  reply({ seq: 11, type: 'response', request_seq: 1, command: 'threads', success: true, body: { threads: ['t'] } });
  assert.deepEqual(await p1, { threads: ['t'] });
  assert.deepEqual(await p2, { scopes: ['s'] });
});

test('a failed response rejects with the adapter\'s message', async () => {
  const { client, reply, tick } = harness();
  const p = client.request('evaluate', { expression: 'nope' });
  await tick();
  reply({ seq: 1, type: 'response', request_seq: 1, command: 'evaluate', success: false, message: 'NameError', body: { error: { format: "name 'nope' is not defined" } } });
  await assert.rejects(p, /name 'nope' is not defined/);
});

test('events and reverse requests are emitted; respond() answers the reverse request', async () => {
  const { client, sent, reply, tick } = harness();
  const events = [], requests = [];
  client.on('event', (m) => events.push(m.event));
  client.on('request', (m) => requests.push(m));
  reply({ seq: 1, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } });
  reply({ seq: 2, type: 'request', command: 'runInTerminal', arguments: { args: ['python'] } });
  await tick();
  assert.deepEqual(events, ['stopped']);
  assert.equal(requests[0].command, 'runInTerminal');
  client.respond(requests[0], { processId: 5 });
  await tick();
  assert.deepEqual(sent[0], { seq: 1, type: 'response', request_seq: 2, command: 'runInTerminal', success: true, body: { processId: 5 } });
});

test('closing the transport rejects pending requests and refuses new ones', async () => {
  const { client, toClient, tick } = harness();
  let closed = false;
  client.on('close', () => { closed = true; });
  const rejected = assert.rejects(client.request('next', { threadId: 1 }, 0), /disconnected/);
  toClient.end();
  await tick();
  await rejected;
  assert.equal(closed, true);
  await assert.rejects(client.request('threads'), /not running/);
});
