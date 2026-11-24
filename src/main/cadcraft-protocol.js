// The drawing engine runs in a different origin from the privileged IDE page.
// Serve only its pinned runtime assets, never workspace or other local files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([{
  scheme: 'cad-editor', privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const vendor = 'vendor/cadcraft/cadcraft-web-0.20.1/';
const host = 'src/renderer/viewer/asset/';
const files = new Map([
  ['/', [host + 'dwg-frame.html', 'text/html']],
  ['/bridge.js', [host + 'dwg-frame.js', 'text/javascript']],
  ['/engine.js', [vendor + 'cadcraft-web-a91fdcd993cc5580.js', 'text/javascript']],
  ['/engine.wasm', [vendor + 'cadcraft-web-a91fdcd993cc5580_bg.wasm', 'application/wasm']],
  ['/snippets/eframe-d31a8450ea12dfc1/inline0.js', [vendor + 'snippets/eframe-d31a8450ea12dfc1/inline0.js', 'text/javascript']],
]);

function installCadcraftProtocol() {
  protocol.handle('cad-editor', async (request) => {
    const url = new URL(request.url);
    const match = url.hostname === 'drawing' && files.get(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const [rel, mime] = match;
    try {
      const bytes = await fs.readFile(path.join(app.getAppPath(), rel));
      return new Response(bytes, { headers: { 'Content-Type': mime } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

module.exports = { installCadcraftProtocol };
