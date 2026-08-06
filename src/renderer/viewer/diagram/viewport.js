import { fitTransform, zoomAt, centerOn, MIN_SCALE, MAX_SCALE } from '../../shared/diagram-view.js';
import { applyTransform } from './svg.js';

// --- diagram viewport ---
// Pan and zoom over the painted SVG. One transform on one <g> (see svg.js), so
// panning a 400-box diagram costs a single attribute write rather than a
// re-render — which is what makes a large project navigable at all.
//
// Every listener is on the host element, not the document, so hiding the
// overlay is enough to make them unreachable — the panel is created once and
// lives for the session, exactly like the browser view.

export function createViewport(svg, host) {
  let t = { scale: 1, x: 0, y: 0 };
  let size = { width: 0, height: 0 };
  let dragging = null;

  const view = () => ({ w: host.clientWidth, h: host.clientHeight });

  function set(next) {
    t = next;
    applyTransform(svg, t);
  }

  function fit() {
    const { w, h } = view();
    set(fitTransform(size, w, h));
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    // Ctrl+wheel is the pinch gesture a trackpad sends; both mean zoom here.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    set(zoomAt(t, factor, e.clientX - rect.left, e.clientY - rect.top));
  }

  function onPointerDown(e) {
    // Left-drag on empty space pans; middle-drag pans from anywhere, so a drag
    // that starts on a box still works.
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && e.target.closest('.dg-node:not(.kind-folder)')) return;
    dragging = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
    host.setPointerCapture(e.pointerId);
    host.classList.add('is-panning');
  }

  function onPointerMove(e) {
    if (!dragging) return;
    set({ scale: t.scale, x: dragging.ox + (e.clientX - dragging.x), y: dragging.oy + (e.clientY - dragging.y) });
  }

  function onPointerUp(e) {
    if (!dragging) return;
    try { host.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    dragging = null;
    host.classList.remove('is-panning');
  }

  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);

  return {
    // A fresh diagram starts fitted; `keep` preserves the current framing, which
    // is what a pass toggle wants (the user was looking at something).
    load(diagram, keep = false) {
      size = { width: diagram.width, height: diagram.height };
      if (keep && t.scale) applyTransform(svg, t);
      else fit();
    },
    fit,
    zoomBy(factor) {
      const { w, h } = view();
      set(zoomAt(t, factor, w / 2, h / 2));
    },
    reveal(node) {
      const { w, h } = view();
      set(centerOn({ scale: Math.max(t.scale, 0.6) }, node, w, h));
    },
    get scale() { return t.scale; },
    get canZoomIn() { return t.scale < MAX_SCALE; },
    get canZoomOut() { return t.scale > MIN_SCALE; },
  };
}
