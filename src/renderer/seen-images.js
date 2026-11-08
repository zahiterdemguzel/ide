// "Seen by AI" panel: a column to the right of the session terminal listing every
// image a tool call showed the model (a Read of an image file, an MCP screenshot),
// in the order the model saw them (oldest at the top, newest at the bottom). Main extracts them from PostToolUse hooks (seen-images-lib.js) and
// pushes `session-image`; sessions.js calls showSeenImagesFor() whenever the
// active session changes. The terminal host's ResizeObserver (panes.js) refits the
// terminal when the panel opens or closes.

// Each entry holds a full data URL, so bound the per-session history.
const MAX_IMAGES_PER_SESSION = 60;
// Whether the user wants the panel open; it only shows when the session has images.
const PANEL_OPEN_STORE = 'ide.seenPanelOpen';

const centerBody = document.getElementById('center-body');
const panel = document.getElementById('seen-panel');
const list = document.getElementById('seen-list');
const toggleBtn = document.getElementById('session-seen');
const countEl = document.getElementById('session-seen-count');

const imagesBySession = new Map();
let shownSessionId = null;
let panelOpen = localStorage.getItem(PANEL_OPEN_STORE) !== 'false';

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function entryElement(image) {
  const item = document.createElement('figure');
  item.className = 'seen-item';
  const img = document.createElement('img');
  img.src = image.src;
  img.alt = image.label;
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(image));
  const caption = document.createElement('figcaption');
  caption.textContent = `${image.label} · ${timeOf(image.at)}`;
  caption.title = `${image.tool} — ${image.label}`;
  item.append(img, caption);
  return item;
}

function render() {
  const images = imagesBySession.get(shownSessionId) || [];
  toggleBtn.hidden = !images.length;
  countEl.textContent = images.length ? String(images.length) : '';
  toggleBtn.setAttribute('aria-pressed', String(panelOpen));
  const visible = panelOpen && images.length > 0;
  panel.hidden = !visible;
  centerBody.classList.toggle('seen-open', visible);
  list.replaceChildren(...images.map(entryElement));
}

export function showSeenImagesFor(sessionId) {
  shownSessionId = sessionId;
  render();
}

function setPanelOpen(open) {
  panelOpen = open;
  localStorage.setItem(PANEL_OPEN_STORE, String(open));
  render();
}

// Full-size view of one image over the whole window; any click or Escape closes it.
let lightbox = null;
function openLightbox(image) {
  closeLightbox();
  lightbox = document.createElement('div');
  lightbox.className = 'seen-lightbox';
  const img = document.createElement('img');
  img.src = image.src;
  img.alt = image.label;
  const caption = document.createElement('div');
  caption.className = 'seen-lightbox-caption';
  caption.textContent = `${image.tool} — ${image.label} · ${timeOf(image.at)}`;
  lightbox.append(img, caption);
  lightbox.addEventListener('click', closeLightbox);
  document.body.appendChild(lightbox);
}
function closeLightbox() {
  if (lightbox) { lightbox.remove(); lightbox = null; }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lightbox) closeLightbox(); });

toggleBtn.addEventListener('click', () => setPanelOpen(!panelOpen));
document.getElementById('seen-close').addEventListener('click', () => setPanelOpen(false));

window.api.onSessionImage(({ id, src, tool, label, at }) => {
  const images = imagesBySession.get(id) || [];
  images.push({ src, tool, label, at });
  if (images.length > MAX_IMAGES_PER_SESSION) images.shift();
  imagesBySession.set(id, images);
  if (id === shownSessionId) {
    render();
    // Oldest first, so the image that just arrived is at the bottom: keep it in view.
    list.scrollTop = list.scrollHeight;
  }
});
window.api.onSessionEvicted(({ ids }) => { for (const id of ids) imagesBySession.delete(id); });
