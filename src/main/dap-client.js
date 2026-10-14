const { EventEmitter } = require('events');
const { encodeDapMessage, createDapReader } = require('./debug-lib');

// One Debug Adapter Protocol connection: numbers outgoing requests, matches the
// adapter's responses back to them, and surfaces everything else as events.
// Transport-agnostic — `connect(readable, writable)` works for an adapter's
// stdio and for a TCP socket alike — and Electron-free, so it's unit-tested.
//
// Emits:
//   'event'   (msg)      — a DAP event (stopped, output, terminated, …)
//   'request' (msg)      — a reverse request from the adapter (runInTerminal,
//                          startDebugging); answer it with respond()
//   'close'              — the transport ended; pending requests are rejected
class DapClient extends EventEmitter {
  constructor() {
    super();
    this.seq = 1;
    this.pending = new Map(); // request seq -> { resolve, reject, timer, command }
    this.writable = null;
    this.closed = false;
  }

  connect(readable, writable) {
    this.writable = writable;
    const reader = createDapReader((msg) => this.receive(msg));
    readable.on('data', (chunk) => reader.push(chunk));
    const onEnd = () => this.close();
    readable.on('end', onEnd);
    readable.on('close', onEnd);
    readable.on('error', onEnd);
    if (writable !== readable) writable.on('error', onEnd);
    return this;
  }

  send(msg) {
    if (this.closed || !this.writable) return false;
    this.writable.write(encodeDapMessage({ seq: this.seq++, ...msg }));
    return true;
  }

  // Send a request and resolve with the response body, or reject with the
  // adapter's error message. `timeoutMs` = 0 waits forever (a `launch` can't
  // answer until configurationDone, which the caller sends meanwhile).
  request(command, args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Debug adapter is not running')); return; }
      const seq = this.seq;
      const timer = timeoutMs
        ? setTimeout(() => { this.pending.delete(seq); reject(new Error(`"${command}" timed out`)); }, timeoutMs)
        : null;
      this.pending.set(seq, { resolve, reject, timer, command });
      this.send({ type: 'request', command, arguments: args });
    });
  }

  // Answer a reverse request from the adapter.
  respond(request, body, error) {
    this.send({
      type: 'response', request_seq: request.seq, command: request.command,
      success: !error, ...(error ? { message: String(error) } : {}), body: body || {},
    });
  }

  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'response') {
      const entry = this.pending.get(msg.request_seq);
      if (!entry) return;
      this.pending.delete(msg.request_seq);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.success) entry.resolve(msg.body || {});
      else entry.reject(new Error((msg.body && msg.body.error && msg.body.error.format) || msg.message || `"${entry.command}" failed`));
    } else if (msg.type === 'event') {
      this.emit('event', msg);
    } else if (msg.type === 'request') {
      this.emit('request', msg);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new Error('Debug adapter disconnected'));
    }
    this.pending.clear();
    this.emit('close');
  }
}

module.exports = { DapClient };
