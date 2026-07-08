// Pure page-list model for the PDF editor. The editor never mutates the PDF in
// memory while editing — it edits this list of page descriptors and only builds
// a new document (pdf-lib copyPages) on Save. Each descriptor is
// `{ src, rotation }`: the page's index in the *original* document and the
// user's added rotation in degrees (0/90/180/270, on top of whatever rotation
// the page already carries in the file). All operations return a new array
// (inputs are never mutated) so the editor's undo stack can hold plain refs.

export function makePages(count) {
  return Array.from({ length: count }, (_, i) => ({ src: i, rotation: 0 }));
}

// Add `delta` degrees (± multiples of 90) to one page's rotation, normalized to 0..270.
export function rotatePage(pages, index, delta) {
  if (index < 0 || index >= pages.length) return pages;
  return pages.map((p, i) =>
    i === index ? { ...p, rotation: ((p.rotation + delta) % 360 + 360) % 360 } : p);
}

// Remove one page. A PDF must keep at least one page, so deleting the last
// remaining page is a no-op (the caller disables the button too).
export function deletePage(pages, index) {
  if (pages.length <= 1 || index < 0 || index >= pages.length) return pages;
  return pages.filter((_, i) => i !== index);
}

// Move a page from one position to another (reorder). Out-of-range → no-op.
export function movePage(pages, from, to) {
  if (from === to || from < 0 || from >= pages.length || to < 0 || to >= pages.length) return pages;
  const next = pages.slice();
  const [p] = next.splice(from, 1);
  next.splice(to, 0, p);
  return next;
}

// True when the list still matches the original document (nothing to save).
export function isIdentity(pages, originalCount) {
  return pages.length === originalCount &&
    pages.every((p, i) => p.src === i && p.rotation === 0);
}
