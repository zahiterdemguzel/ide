// Registers IPC handlers with Electron AND records them in a registry so the
// remote server (src/main/remote.js) can call the same functions on behalf of
// a paired mobile client. Subsystems that should be remotely callable import
// { handle, on } from here instead of using ipcMain directly; handler bodies
// are unchanged. Handlers receive a stub event { sender: null, remote: true,
// deviceId } when invoked remotely — all bridged handlers ignore the event arg.

const { ipcMain } = require('electron');

const registry = new Map(); // channel -> { fn, kind: 'handle' | 'on' }

function handle(channel, fn) {
  ipcMain.handle(channel, fn);
  registry.set(channel, { fn, kind: 'handle' });
}

function on(channel, fn) {
  ipcMain.on(channel, fn);
  registry.set(channel, { fn, kind: 'on' });
}

// kind: 'req' (mirrors handle) or 'send' (mirrors on). The allowlist check
// happens in server/protocol.js before this is reached.
async function invokeRemote(kind, channel, args, ctx) {
  const entry = registry.get(channel);
  if (!entry) throw new Error('unknown-channel');
  const event = { sender: null, remote: true, deviceId: ctx && ctx.deviceId };
  const result = entry.fn(event, args);
  return kind === 'req' ? await result : undefined;
}

module.exports = { handle, on, invokeRemote };
