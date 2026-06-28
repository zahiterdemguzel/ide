// Pure pixel-buffer operations for the pixel editor — no DOM/canvas, so they're
// unit-testable. `data` is a flat RGBA byte array (Uint8ClampedArray-like) of
// length w*h*4, row-major, exactly as `CanvasRenderingContext2D.getImageData`
// hands it over.

// Flood-fill from (sx, sy): recolour every pixel reachable through 4-connected
// neighbours whose colour is within `threshold` of the seed pixel's colour.
// `fill` is an [r, g, b, a] tuple (use [0,0,0,0] to flood-erase). `threshold`
// is 0–100 — the percentage of the max per-channel distance still counted as a
// match, so 0 fills only pixels identical to the seed. Mutates `data` in place
// and returns the number of pixels changed.
export function floodFill(data, w, h, sx, sy, fill, threshold) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;

  const seed = (sy * w + sx) * 4;
  const target = [data[seed], data[seed + 1], data[seed + 2], data[seed + 3]];

  // Seed already holds the fill colour — a fill would be a no-op, so skip the scan.
  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return 0;

  // Max allowed per-channel difference; threshold 0 ⇒ exact match only.
  const tol = Math.round((threshold / 100) * 255);
  const matches = (i) =>
    Math.abs(data[i] - target[0]) <= tol &&
    Math.abs(data[i + 1] - target[1]) <= tol &&
    Math.abs(data[i + 2] - target[2]) <= tol &&
    Math.abs(data[i + 3] - target[3]) <= tol;

  const seen = new Uint8Array(w * h);
  const stack = [sx, sy]; // flat x,y pairs — cheaper than allocating a tuple per push
  let changed = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!matches(i)) continue;
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
    changed++;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return changed;
}
