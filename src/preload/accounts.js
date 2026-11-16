const { ipcRenderer } = require('electron');

// Multiple Claude accounts: the toolbar switcher, sign-in, and the usage of each.
module.exports = {
  listAccounts: (opts) => ipcRenderer.invoke('accounts-list', opts),
  // `kind` is 'claude' (signed in afterwards) or 'apiKey' (needs `apiKey`).
  addAccount: (name, kind, apiKey) => ipcRenderer.invoke('accounts-add', { name, kind, apiKey }),
  setAccountApiKey: (id, apiKey) => ipcRenderer.invoke('accounts-set-api-key', { id, apiKey }),
  // `{ limitUsd, period: 'month' | 'total' }` (limitUsd 0 = no limit) or `{ reset: true }`.
  setAccountBudget: (id, budget) => ipcRenderer.invoke('accounts-set-budget', { id, ...budget }),
  removeAccount: (id) => ipcRenderer.invoke('accounts-remove', id),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts-rename', { id, name }),
  setAccountAutoSwitch: (id, allowed) => ipcRenderer.invoke('accounts-set-auto-switch', { id, allowed }),
  setActiveAccount: (id) => ipcRenderer.invoke('accounts-set-active', id),
  accountLoginCommand: (id) => ipcRenderer.invoke('accounts-login-command', id),
  accountsUsage: () => ipcRenderer.invoke('accounts-usage'),
  onAccountChanged: (cb) => ipcRenderer.on('account-changed', (_e, msg) => cb(msg)),
};
