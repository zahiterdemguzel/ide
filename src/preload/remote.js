const { ipcRenderer } = require('electron');

// Remote (mobile) access controls: enable/disable the LAN server, mint pairing
// QR payloads, and manage paired devices. Desktop-only — never remotely callable.
module.exports = {
  remoteStatus: () => ipcRenderer.invoke('remote-status'),
  remoteEnable: () => ipcRenderer.invoke('remote-enable'),
  remoteDisable: () => ipcRenderer.invoke('remote-disable'),
  remoteNewPairToken: () => ipcRenderer.invoke('remote-new-pair-token'),
  remoteDevices: () => ipcRenderer.invoke('remote-devices'),
  remoteRevokeDevice: (id) => ipcRenderer.invoke('remote-revoke-device', id),
  onRemoteClientsChanged: (cb) => ipcRenderer.on('remote-clients-changed', (_e, count) => cb(count)),
};
