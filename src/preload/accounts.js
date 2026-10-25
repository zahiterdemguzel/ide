const { ipcRenderer } = require('electron');

// Multiple Claude accounts: the toolbar switcher, sign-in, and the usage of each.
module.exports = {
  listAccounts: (opts) => ipcRenderer.invoke('accounts-list', opts),
  addAccount: (name) => ipcRenderer.invoke('accounts-add', name),
  removeAccount: (id) => ipcRenderer.invoke('accounts-remove', id),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts-rename', { id, name }),
  setActiveAccount: (id) => ipcRenderer.invoke('accounts-set-active', id),
  accountLoginCommand: (id) => ipcRenderer.invoke('accounts-login-command', id),
  accountsUsage: () => ipcRenderer.invoke('accounts-usage'),
  onAccountChanged: (cb) => ipcRenderer.on('account-changed', (_e, msg) => cb(msg)),
};
