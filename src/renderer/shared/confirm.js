console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/confirm.js'); // PERF-TEMP
// Styled modal confirm, reusing the #confirm-dialog element (same chrome as the
// "Change folder?" / git-error dialogs). Resolves true on OK, false on Cancel /
// Esc / backdrop. `danger: true` paints the OK button red for destructive acts.
export function confirmDialog({ title, message, ok = 'OK', danger = false } = {}) {
  const dlg = document.getElementById('confirm-dialog');
  const okBtn = document.getElementById('confirm-ok');
  document.getElementById('confirm-title').textContent = title || '';
  document.getElementById('confirm-msg').textContent = message || '';
  okBtn.textContent = ok;
  okBtn.classList.toggle('confirm-btn-danger', danger);

  return new Promise((resolve) => {
    const done = (result) => {
      okBtn.onclick = null;
      document.getElementById('confirm-cancel').onclick = null;
      dlg.onclose = null;
      dlg.close();
      resolve(result);
    };
    okBtn.onclick = () => done(true);
    document.getElementById('confirm-cancel').onclick = () => done(false);
    dlg.onclose = () => resolve(false); // Esc / backdrop
    dlg.showModal();
  });
}
