// Markdown preview for .md files (the head's Code | Preview switch). Rendered
// with `marked` into a plain div in the app window, so it must never carry live
// markup from the file: a repo's README could otherwise inject
// <script src="./evil.js">, which the page CSP allows (same origin) and which
// would run with the app's IPC bridge. Raw HTML blocks/inline HTML are therefore
// rendered as escaped text, links are routed through the app's link opener
// instead of navigating, and relative image paths resolve against the file's
// folder.

let markedModule = null;

async function loadMarked() {
  if (!markedModule) markedModule = await import('../../../node_modules/marked/lib/marked.esm.js');
  return markedModule;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function toFileUrl(absPath) {
  const norm = absPath.replace(/\\/g, '/');
  return 'file://' + (norm.startsWith('/') ? '' : '/') + norm.split('/').map(encodeURIComponent).join('/');
}

// `baseDir` is the absolute folder of the markdown file (for relative images);
// `onLink(href)` opens a clicked link.
export async function renderMarkdownPreview(text, baseDir, onLink) {
  const { Marked } = await loadMarked();
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      html({ text: raw }) { return escapeHtml(raw); },
      image({ href, title, text: alt }) {
        let src = href || '';
        if (src && !/^(https?:|data:|file:)/i.test(src) && baseDir) {
          const clean = src.replace(/^\.\//, '');
          src = toFileUrl(clean.startsWith('/') ? clean : `${baseDir.replace(/[\\/]$/, '')}/${clean}`);
        }
        if (/^javascript:/i.test(src)) src = '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      },
    },
  });
  const el = document.createElement('div');
  el.className = 'md-preview';
  el.innerHTML = md.parse(text);
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      const target = el.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!/^javascript:/i.test(href)) onLink(href);
  });
  // GitHub-style heading anchors so in-page links (#section) work.
  for (const h of el.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    h.id = h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  }
  return el;
}
