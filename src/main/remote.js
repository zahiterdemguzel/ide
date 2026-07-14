// Desktop side of remote (mobile) access. Owns the paired-device store, embeds
// the Electron-free ws server from server/ while remote access is enabled, and
// forwards renderer pushes to remote clients. Off by default; the server only
// listens while the user enables it in the remote pane. These desktop-control
// channels use raw ipcMain deliberately — they must never be remotely callable.

const { ipcMain, app } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');
const { onBroadcast } = require('./window');
const { invokeRemote } = require('./remote-bridge');
const { startRemoteServer } = require('../../server/ws-server');
const { startPortForward } = require('../../server/http-proxy');

// Paired devices persist machine-wide (like recent-folders.json): pairing a
// phone once should survive app restarts and instances. Only token hashes are
// stored — see server/auth-lib.js.
const devicesFile = path.join(sharedDataDir, 'remote-devices.json');
const deviceStore = {
  load() {
    try {
      const list = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
      if (Array.isArray(list)) return list;
    } catch {}
    return [];
  },
  save(list) {
    try { fs.writeFileSync(devicesFile, JSON.stringify(list)); } catch (err) { console.error('[remote devices save]', err); }
  },
};

let server = null; // { port, pairing, broadcast, close } while enabled
const forwards = new Map(); // targetPort -> proxy handle ({ port, issueUrlToken, close })

// Dev-server port forwarding: proxy desktop 127.0.0.1:<target> onto the LAN
// with a one-time auth URL the phone's browser opens. Proxies die with the
// remote server (disable/quit).
const forward = {
  async open(targetPort) {
    if (!forwards.has(targetPort)) forwards.set(targetPort, await startPortForward({ targetPort }));
    const proxy = forwards.get(targetPort);
    const host = lanAddresses()[0] || '127.0.0.1';
    return `http://${host}:${proxy.port}/?_ideauth=${proxy.issueUrlToken()}`;
  },
  async close(targetPort) {
    const proxy = forwards.get(targetPort);
    forwards.delete(targetPort);
    if (proxy) await proxy.close();
  },
};

async function closeAllForwards() {
  const all = [...forwards.values()];
  forwards.clear();
  await Promise.all(all.map((p) => p.close().catch(() => {})));
}

// Non-internal IPv4 addresses, best candidate first (prefer private ranges so
// the QR points at the LAN IP, not a VPN/virtual adapter address).
function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
    }
  }
  const isPrivate = (a) => a.startsWith('192.168.') || a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return addrs.sort((a, b) => isPrivate(b) - isPrivate(a));
}

function status() {
  return {
    enabled: !!server,
    port: server ? server.port : null,
    hosts: server ? lanAddresses() : [],
  };
}

async function enable() {
  if (server) return status();
  server = await startRemoteServer({
    port: 0,
    invoke: invokeRemote,
    deviceStore,
    appVersion: app.getVersion(),
    forward,
  });
  return status();
}

async function disable() {
  if (!server) return status();
  const s = server;
  server = null;
  await closeAllForwards();
  await s.close();
  return status();
}

// Renderer pushes fan out to remote clients too (protocol.js filters to the
// remote-event allowlist, so desktop-only channels never leave the machine).
onBroadcast((channel, payload) => {
  if (server) server.broadcast(channel, payload);
});

ipcMain.handle('remote-status', () => status());
ipcMain.handle('remote-enable', () => enable());
ipcMain.handle('remote-disable', () => disable());

// A fresh single-use pairing token, encoded as the ide://pair URL the QR shows.
// Reissuing invalidates the previous token (see server/auth-lib.js).
ipcMain.handle('remote-new-pair-token', () => {
  if (!server) return null;
  const token = server.pairing.issue();
  const host = lanAddresses()[0] || '127.0.0.1';
  return `ide://pair?v=1&host=${encodeURIComponent(host)}&port=${server.port}&tk=${token}`;
});

ipcMain.handle('remote-devices', () =>
  deviceStore.load().map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })));

ipcMain.handle('remote-revoke-device', (_e, id) => {
  deviceStore.save(deviceStore.load().filter((d) => d.id !== id));
  return true;
});

app.on('before-quit', () => { if (server) server.close(); closeAllForwards(); });

module.exports = { status };
