// CADCraft's same-document host bridge lives in the isolated drawing frame.
// The host can send drawing bytes and a fixed set of editor actions.
const canvas = document.getElementById('cadcraft_canvas');
const send = (type, detail) => window.parent.postMessage({ type, ...detail }, '*');
for (const type of ['cadcraft:ready', 'cadcraft:save', 'cadcraft:dirty', 'cadcraft:failed']) {
  canvas.addEventListener(type, (event) => send(type, event.detail));
}
const interactiveTools = new Set(['line', 'pline', 'circle', 'rectang', 'move', 'copy', 'rotate', 'trim', 'mtext', 'dimlinear']);

async function runCommand(command) {
  const api = window.cadcraft;
  if (command === 'fit') {
    await api.execute('zoom', { mode: 'extents' });
  } else if (command === 'undo' || command === 'redo') {
    await api.execute(command, { count: 1 });
  } else if (interactiveTools.has(command)) {
    const state = await api.request('cmdline.state', {});
    if (state.running) await api.request('cmdline.key', { key: 'escape' });
    const result = await api.request('cmdline.input', { text: command });
    if (result.error) throw new Error(result.error);
  }
  canvas.focus();
}
window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type === 'cadcraft:open') {
    // CADCraft updates the page title once it has consumed the drawing. Fit
    // model space after that frame so stale DWG view extents cannot hide it.
    const opened = new MutationObserver(async () => {
      if (document.title !== event.data.name + ' — CADCraft') return;
      opened.disconnect();
      // Apply the compact layout once. Later resizes and palette choices
      // belong to the user for the rest of this drawing session.
      if (window.innerWidth < 600) await window.cadcraft.request('ui.set', { showPalettes: false });
      try { await window.cadcraft.execute('zoom', { mode: 'extents' }); } catch { /* Empty drawing. */ }
      send('ide:opened');
    });
    opened.observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
    canvas.dispatchEvent(new CustomEvent('cadcraft:open', { detail: event.data }));
  } else if (event.data?.type === 'ide:appearance') {
    const { theme, language } = event.data;
    if (theme === 'dark' || theme === 'light') await window.cadcraft.execute('ui.theme', { theme });
    if (['en', 'tr', 'es', 'de', 'fr'].includes(language)) await window.cadcraft.execute('ui.language', { lang: language });
  } else if (event.data?.type === 'ide:command') {
    try {
      await runCommand(event.data.command);
      send('ide:command-finished');
    } catch (e) {
      send('ide:command-finished', { error: String(e.message || e) });
    }
  } else if (event.data?.type === 'ide:save') {
    try {
      const doc = await window.cadcraft.docInspect();
      const title = doc.title.replace(/\.dxf$/i, '');
      await window.cadcraft.execute('saveas', { path: title + '.dxf' });
    } catch (e) {
      send('ide:save-failed', { error: String(e.message || e) });
    }
  }
});
try {
  const { default: initialize } = await import('/engine.js');
  await initialize({ module_or_path: '/engine.wasm' });
} catch (e) {
  send('cadcraft:failed', { error: String(e) });
}
