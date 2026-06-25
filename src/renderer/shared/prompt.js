// A minimal modal text prompt. Resolves to the trimmed input, or null if the
// user cancels (Cancel button, backdrop click, or Escape). Only one is open at a
// time. Enter confirms, Escape cancels.
export function promptText({ title, label, placeholder = '', value = '', error = '' } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML =
      `<div class="modal-title"></div>` +
      (label ? `<div class="modal-label"></div>` : '') +
      `<input class="modal-input" type="text" />` +
      `<div class="modal-error"></div>` +
      `<div class="modal-actions">` +
        `<button class="modal-cancel">Cancel</button>` +
        `<button class="modal-ok">Create</button>` +
      `</div>`;
    box.querySelector('.modal-title').textContent = title || '';
    if (label) box.querySelector('.modal-label').textContent = label;
    if (error) box.querySelector('.modal-error').textContent = error;

    const input = box.querySelector('.modal-input');
    input.placeholder = placeholder;
    input.value = value;

    function close(result) {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    }
    function confirm() {
      const v = input.value.trim();
      close(v || null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    }

    box.querySelector('.modal-ok').onclick = confirm;
    box.querySelector('.modal-cancel').onclick = () => close(null);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
    window.addEventListener('keydown', onKey, true);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    input.focus();
  });
}
