import { base64ToArrayBuffer } from '../../shared/base64.js';

// Shared pdf.js loader for the PDF view and editor. Both pdfjs-dist and its
// worker module resolve through the index.html import map and are imported on
// first use so they never cost app startup. The worker module is imported into
// the *main thread* on purpose: it registers `globalThis.pdfjsWorker`, which
// pdf.js detects and uses directly instead of spawning a Web Worker. A real
// worker can't be used here — on a file:// page `location.origin` is "null",
// so pdf.js treats its own (same-folder) worker as cross-origin and wraps it
// in a blob: worker, which the app CSP blocks — the document then never opens.
let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/worker'),
    ]).then(([pdfjs]) => {
      // Unused on the main-thread path, but pdf.js requires it to be set.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', document.baseURI).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// Open a document from the read-asset base64. `isEvalSupported: false` keeps
// pdf.js off `new Function` (Type3/PostScript font paths) so it stays CSP-clean.
export async function openPdf(base64) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(base64ToArrayBuffer(base64)),
    isEvalSupported: false,
  }).promise;
}

// Render one page into a fresh <canvas> at `cssWidth` CSS pixels wide, sharp on
// hidpi screens (backing store scaled by devicePixelRatio). Returns the canvas.
export async function renderPageCanvas(page, cssWidth) {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}
