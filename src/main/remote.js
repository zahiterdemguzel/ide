// Desktop side of remote (mobile) access. Owns the paired-device store and, while
// remote access is enabled, reaches phones over one outbound socket to the cloud
// relay (a machine behind NAT can't be dialled in to, but it can dial out). The
// hub (server/hub.js) runs the pair/auth machine and one broadcast reaches every
// phone in the room. Off by default. These desktop-control channels use raw
// ipcMain deliberately — they must never be remotely callable.

const { ipcMain, app } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { sharedDataDir, instanceId } = require('./instance');
const { onBroadcast, sendToRenderer } = require('./window');
const { handle, invokeRemote } = require('./remote-bridge');
const { getRepoPath, onRepoChange } = require('./repo');
const registry = require('./instance-registry');
const { createHub } = require('../../server/hub');
const { startRelayClient } = require('../../server/relay-client');
const { startPortForward } = require('../../server/http-proxy');
const { normalizeForwardPath } = require('../../server/http-proxy-lib');
const {
  normalizeConfig, isRoom, resolveRelayUrl, relayUrlForPhone,
} = require('./remote-config-lib');
const push = require('./push');
const remoteBrowser = require('./remote-browser');
const remoteControl = require('./remote-control');

// The Ports *tab* stays parked while the remote browser (remote-browser.js) covers
// mobile testing, but the forwarding plumbing itself is back on: APK sideloading
// uses it as its off-LAN/firewalled download path (the phone forwards the apk-server
// port over the relay when no LAN URL answers — see installApk.ts). The phone UI
// gate is SHOW_PORTS_TAB in mobile/.
const PORT_FORWARDING_ENABLED = true;

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

// The paired devices outlive the process, so the *service* they reach has to as
// well: on/off and the relay room persist beside them (see remote-config-lib.js
// for why the room can't be ephemeral).
const configFile = path.join(sharedDataDir, 'remote-config.json');
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; }
}
function saveConfig(next) {
  config = next;
  try { fs.writeFileSync(configFile, JSON.stringify(config)); } catch (err) { console.error('[remote config save]', err); }
}

// Push notifications ride the device store: a phone registers its Expo token over
// the protocol, and sessions.js fires notifySessionCompleted through push.js.
push.init(deviceStore);

const rawConfig = readConfigFile();
let config = normalizeConfig(rawConfig);
// The room id is minted on first run and every phone paired from then on holds it,
// so it has to be on disk before the first QR is shown — not just in memory.
if (!rawConfig || !isRoom(rawConfig.room)) saveConfig(config);

// The relay this run talks to: the one on this machine while developing, the
// deployed one from a build. Resolved here rather than read off `config` so the
// dev URL is never written back to the shared config file — see resolveRelayUrl.
const relayUrl = resolveRelayUrl({
  isDev: !app.isPackaged,
  env: process.env,
  stored: rawConfig && rawConfig.relayUrl,
});
// What a *phone* must dial to reach that same relay (localhost is the phone).
const phoneRelayUrl = () => relayUrlForPhone(relayUrl, lanAddresses()[0]);

let hub = null;
let relay = null; // outbound socket to the cloud relay, while enabled
let enabled = false;
const forwards = new Map(); // targetPort -> proxy handle ({ port, issueUrlToken, close })

async function proxyFor(targetPort) {
  if (!forwards.has(targetPort)) forwards.set(targetPort, await startPortForward({ targetPort }));
  return forwards.get(targetPort);
}

// Dev-server port forwarding: one local reverse proxy per target port, opened in
// the phone's browser through a /p/<room>/<instance>/<port> entry URL on the
// relay, which splices the browser's raw bytes down our relay socket and into
// that proxy. Proxies die with the remote service (disable/quit).
//
// The link lands on `path` ('/admin') if the phone asked for one, and on the site
// root otherwise. Either way it is the whole site that is forwarded, not that one
// page: the auth cookie the token swaps itself for is Path=/, so from there the
// browser can walk to any other path on the same address.
const forward = {
  async open(targetPort, _ctx, path) {
    const proxy = await proxyFor(targetPort);
    const token = proxy.issueUrlToken();
    const at = normalizeForwardPath(path) || '/';
    const auth = `${at.includes('?') ? '&' : '?'}_ideauth=${token}`;
    // Named down to this window, not just this machine: a sibling may be proxying
    // the same target port, and the token is only good at the proxy that issued it.
    return `${phoneRelayUrl()}/p/${config.room}/${instanceId}/${targetPort}${at}${auth}`;
  },
  async close(targetPort) {
    const proxy = forwards.get(targetPort);
    forwards.delete(targetPort);
    if (proxy) await proxy.close();
  },
};

// What the relay client pipes a tunnelled browser connection into: the local
// proxy for that port. It only ever hands back a port — all the HTTP, the auth
// cookie and the HMR upgrade stay inside http-proxy.js.
const tunnel = { localPort: async (targetPort) => (await proxyFor(targetPort)).port };

async function closeAllForwards() {
  const all = [...forwards.values()];
  forwards.clear();
  await Promise.all(all.map((p) => p.close().catch(() => {})));
}

// Non-internal IPv4 addresses, best candidate first (prefer private ranges over a
// VPN/virtual adapter address). Used only to rewrite a dev relay's `localhost`
// into an address a phone on the network can reach (see relayUrlForPhone).
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
    enabled,
    relayUrl: phoneRelayUrl(), // what the pane shows, so show what a phone dials
    room: config.room,
    relayConnected: !!relay && relay.connected(),
  };
}

// The entry names the relay this window dials: a dev run talks to the local relay
// while an installed build talks to the hosted one, and both publish into the same
// machine-wide file — a phone can only reach windows in *its* relay's room, so the
// roster must not offer it the others.
const publishInstance = () => registry.publish({ project: getRepoPath(), relay: relayUrl });

async function enable() {
  if (enabled) return status();
  hub = createHub({
    invoke: invokeRemote,
    deviceStore,
    appVersion: app.getVersion(),
    forward: PORT_FORWARDING_ENABLED ? forward : undefined,
    // The toolbar shows a phone icon while at least one paired device holds a
    // live socket to this window; the remote browser stops rendering when the
    // last one leaves.
    onClientsChanged: (count) => {
      sendToRenderer('remote-clients-changed', count);
      remoteBrowser.onClientCount(count);
      remoteControl.onClientCount(count);
    },
  });
  remoteBrowser.setBroadcast((ch, payload) => { if (hub) hub.broadcast(ch, payload); });
  remoteControl.setBroadcast((ch, payload) => { if (hub) hub.broadcast(ch, payload); });
  // The desktop dials out to the relay because a machine behind NAT can't be
  // dialled in to; every phone in its room rides that one socket. Failing to reach
  // the relay is not fatal — it retries in the background.
  console.log(`[remote] relay ${relayUrl}${app.isPackaged ? '' : ' (dev)'}`);
  relay = startRelayClient({
    relayUrl, // the desktop's own route to it: localhost in dev, no rewrite needed
    room: config.room,
    instance: instanceId,
    hub,
    tunnel: PORT_FORWARDING_ENABLED ? tunnel : undefined,
    log: (msg) => console.log(msg),
  });
  enabled = true;
  push.setEnabled(true); // notifications are part of the service: off means silent
  // Now reachable, so say so: this is what puts this window in the list a phone
  // chooses from.
  publishInstance();
  // ...and keep saying so: an entry that stops being refreshed is how a reader tells
  // this window apart from one that was killed and left its entry behind.
  registry.startHeartbeat();
  if (!config.enabled) saveConfig({ ...config, enabled: true });
  return status();
}

// The list is what windows are *reachable*, not what windows exist, so an instance
// with remote access off must not be in it — a phone could see it but never dial it.
async function disable() {
  if (config.enabled) saveConfig({ ...config, enabled: false });
  if (!enabled) return status();
  registry.remove();
  enabled = false;
  push.setEnabled(false);
  if (relay) relay.close();
  relay = null;
  hub = null;
  remoteBrowser.setBroadcast(null);
  remoteControl.setBroadcast(null);
  sendToRenderer('remote-clients-changed', 0);
  await closeAllForwards();
  return status();
}

// The project is the one thing in a window's entry that changes while it runs, and it
// is the thing the phone picks by — so republish whenever it does.
onRepoChange(() => { if (enabled) publishInstance(); });

// Every window this machine is running, oldest first — what the phone's welcome screen
// lists. Served by whichever window the phone's socket happens to land on: they have no
// IPC between them, so they answer for each other out of the shared registry file.
//
// Bridged (not raw ipcMain) precisely because it must be remotely callable, unlike the
// remote-* control channels below.
// Only windows on *this window's* relay: the phone's socket rides one relay, and a
// sibling on a different one (a dev run beside an installed build) is in a different
// room there — offering it would be offering a window the phone can never dial.
// Entries without a relay (written by a pre-relay-only build) are excluded too.
// The calling phone registers (or clears, token: null) its Expo push token, so
// the desktop can notify it of completed sessions while the app is closed. Bound
// to the caller's own device record — one phone can never register for another.
handle('register-push', (event, { token } = {}) => push.registerToken(event.deviceId, token ?? null));

handle('list-instances', () => registry.list()
  .filter((e) => e.relay === relayUrl)
  .map((e) => ({
    id: e.id,
    startedAt: e.startedAt,
    project: e.project || null,
    current: e.id === instanceId,
  })));

// Remote access is a service, not a per-window toggle. A phone paired to this
// machine reconnects on its own (backoff, stored device token) but has nothing to
// reach until the server is listening again — and it can't ask anyone to re-open
// Settings — so restore the last state as soon as the app is up.
app.whenReady().then(() => {
  if (config.enabled) enable().catch((err) => console.error('[remote autostart]', err));
});

// Renderer pushes fan out to remote clients too (protocol.js filters to the
// remote-event allowlist, so desktop-only channels never leave the machine).
//
// `sessions-changed` is the exception: the desktop renderer reconciles against the
// whole list, but a phone pages its list over `query-sessions` and would only throw
// the payload away — so remote clients get it as a bare signal ("refetch your
// page"). Shipping every session, archived ones included, on every list change is
// exactly what the paging exists to avoid.
onBroadcast((channel, payload) => {
  if (!hub) return;
  hub.broadcast(channel, channel === 'sessions-changed' ? null : payload);
});

ipcMain.handle('remote-status', () => status());
ipcMain.handle('remote-enable', () => enable());
ipcMain.handle('remote-disable', () => disable());

// A fresh single-use pairing token, encoded as the ide://pair URL the QR shows.
// Reissuing invalidates the previous token (see server/auth-lib.js). It carries
// the relay origin and the room — the phone's address for this machine anywhere.
ipcMain.handle('remote-new-pair-token', () => {
  if (!enabled) return null;
  const token = hub.pairing.issue();
  const q = [
    'v=1',
    `relay=${encodeURIComponent(phoneRelayUrl())}`,
    `room=${encodeURIComponent(config.room)}`,
    `tk=${token}`,
  ];
  return `ide://pair?${q.join('&')}`;
});

ipcMain.handle('remote-devices', () =>
  deviceStore.load().map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })));

ipcMain.handle('remote-revoke-device', (_e, id) => {
  deviceStore.save(deviceStore.load().filter((d) => d.id !== id));
  return true;
});

app.on('before-quit', () => {
  // Drop out of the list before the socket goes: a phone must not be offered a window
  // that is on its way out. A window that is killed or crashes never reaches this, so
  // the reader prunes dead entries too (see instance-registry.js).
  registry.remove();
  if (relay) relay.close();
  closeAllForwards();
});

module.exports = { status };
