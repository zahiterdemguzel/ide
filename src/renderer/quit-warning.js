// The Chrome-style "Press ⌘Q again to quit" pill. Main (quit-guard.js) swallows
// the first Cmd+Q and sends 'quit-warning'; the pill stays up for as long as a
// second press would still quit.
import { t } from '../i18n/index.js';

let pill = null;
let hideTimer = null;

function ensurePill() {
  if (pill) return pill;
  pill = document.createElement('div');
  pill.className = 'quit-warning';
  pill.setAttribute('role', 'status');
  document.body.appendChild(pill);
  return pill;
}

function showQuitWarning({ windowMs }) {
  const el = ensurePill();
  el.textContent = t('app.quitWarning');
  el.classList.add('visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('visible'), windowMs);
}

window.api.onQuitWarning(showQuitWarning);
