// DOM side of the file icons: turns an icon id from file-icons.js into an <img>
// pointing at the matching SVG. Kept apart from the pure mapping so that stays
// unit-testable. Paths are relative to index.html (repo root) and load under the
// page's CSP `img-src 'self'`, same as every other app-local resource.

import { iconForFile, iconForFolder } from './file-icons.js';

const ICON_DIR = 'src/renderer/file-icons/';
const src = (id) => ICON_DIR + id + '.svg';

function imgFor(id) {
  const img = document.createElement('img');
  img.className = 'tree-icon';
  img.src = src(id);
  img.alt = '';
  img.draggable = false; // the row owns the drag; the icon shouldn't start its own
  return img;
}

export function fileIcon(name) { return imgFor(iconForFile(name)); }
export function folderIcon(open = false) { return imgFor(iconForFolder(open)); }
export function setFolderIcon(img, open) { img.src = src(iconForFolder(open)); }
