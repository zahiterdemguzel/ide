// Line-level diff for the editor's gutter change markers (VS Code's "dirty
// diff"): compares the committed text with the live buffer and reports which
// lines of the buffer were added or modified, and where lines were deleted.
// Pure and unit-tested.
//
// Algorithm: strip the common prefix/suffix (most edits are local, so this
// usually leaves a tiny middle), then run Myers' O(ND) diff on what's left. A
// pathological middle (D beyond MAX_EDIT_DISTANCE) gives up and marks the whole
// middle as modified rather than stalling the renderer.

const MAX_EDIT_DISTANCE = 2000;

export function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

// Myers shortest edit script over arrays a/b → list of ops: 'eq' | 'del' | 'ins',
// each consuming one line of a (eq/del) and/or b (eq/ins). Returns null past the cap.
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, offset, dEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('eq'); x--; y--; }
    ops.push(x === prevX ? 'ins' : 'del');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push('eq'); x--; y--; }
  return ops.reverse();
}

// → [{ type: 'added'|'modified'|'deleted', start, end }] in 1-based buffer line
// numbers. For 'deleted', start === end === the buffer line the removed block
// sat just below (0 when it was removed from the very top).
export function lineChanges(baseText, currentText) {
  const a = splitLines(baseText);
  const b = splitLines(currentText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (!midA.length && !midB.length) return [];

  const ops = myers(midA, midB);
  if (!ops) {
    if (!midB.length) return [{ type: 'deleted', start: pre, end: pre }];
    return [{ type: midA.length ? 'modified' : 'added', start: pre + 1, end: pre + midB.length }];
  }

  // Group consecutive non-equal ops into hunks; a hunk with both deletions and
  // insertions is a modification of its inserted lines.
  const changes = [];
  let line = pre; // buffer lines consumed so far
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === 'eq') { line++; i++; continue; }
    let dels = 0;
    let ins = 0;
    while (i < ops.length && ops[i] !== 'eq') {
      if (ops[i] === 'del') dels++; else ins++;
      i++;
    }
    if (ins === 0) changes.push({ type: 'deleted', start: line, end: line });
    else changes.push({ type: dels ? 'modified' : 'added', start: line + 1, end: line + ins });
    line += ins;
  }
  return changes;
}
