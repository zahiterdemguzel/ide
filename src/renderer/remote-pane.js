// Remote access dialog: toggles the relay connection, shows the pairing QR, and
// lists/revokes paired devices. The QR encodes the ide://pair URL from main
// (relay origin + room + single-use token); it is re-minted every time the dialog
// is opened or "New code" is clicked, since tokens are single-use with a 5-minute TTL.
import { t } from '../i18n/index.js';
import qrcode from 'qrcode-generator';

function renderQr(el, text) {
  const qr = qrcode(0, 'M'); // type 0 = auto-size
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

export function initRemotePane() {
  // Toolbar phone icon (left of the usage meter): visible while at least one
  // paired mobile device holds a live socket to this window.
  const phoneIndicator = document.getElementById('phone-indicator');
  window.api.onRemoteClientsChanged?.((count) => { phoneIndicator.hidden = !count; });

  const enableBox = document.getElementById('remote-enable');
  const qrWrap = document.getElementById('remote-qr-wrap');
  const qrEl = document.getElementById('remote-qr');
  const addrEl = document.getElementById('remote-addr');
  const deviceList = document.getElementById('remote-device-list');

  async function refreshQr() {
    const url = await window.api.remoteNewPairToken();
    qrWrap.hidden = !url;
    if (!url) return;
    renderQr(qrEl, url);
    const relay = new URL(url).searchParams.get('relay');
    addrEl.textContent = relay ? new URL(relay).host : '';
  }

  async function refreshDevices() {
    const devices = await window.api.remoteDevices();
    deviceList.innerHTML = '';
    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'settings-group-hint';
      empty.textContent = t('remote.noDevices');
      deviceList.appendChild(empty);
      return;
    }
    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const label = document.createElement('span');
      label.textContent = `${d.name} — ${t('remote.lastSeen')} ${new Date(d.lastSeen).toLocaleString()}`;
      const revoke = document.createElement('button');
      revoke.className = 'settings-secondary';
      revoke.textContent = t('remote.revoke');
      revoke.onclick = async () => {
        await window.api.remoteRevokeDevice(d.id);
        refreshDevices();
      };
      row.append(label, revoke);
      deviceList.appendChild(row);
    }
  }

  async function applyStatus(status) {
    enableBox.checked = status.enabled;
    if (status.enabled) await refreshQr();
    else qrWrap.hidden = true;
  }

  enableBox.onchange = async () => {
    const status = enableBox.checked
      ? await window.api.remoteEnable()
      : await window.api.remoteDisable();
    await applyStatus(status);
  };

  document.getElementById('remote-new-code').onclick = refreshQr;

  // The remote group lives inside the Settings dialog; settings.js owns the
  // dialog open (via .onclick), so listen additively for the same click to
  // refresh server status, the QR, and the device list whenever it opens.
  document.getElementById('settings-btn').addEventListener('click', async () => {
    await applyStatus(await window.api.remoteStatus());
    await refreshDevices();
  });
}
