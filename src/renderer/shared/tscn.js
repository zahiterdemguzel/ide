// Pure text-level model of Godot's .tscn scene format (godotengine/godot's
// ResourceFormatText). A scene file is an INI-like list of sections —
// `[gd_scene ...]` descriptor, `[ext_resource ...]`, `[sub_resource ...]`,
// `[node ...]`, `[connection ...]` — each with `key = value` property lines.
// Parsing keeps every attribute and property as its raw source string so a
// file round-trips losslessly through parse → serialize; only the values an
// edit touches are rewritten. No DOM / three.js here so it stays unit-testable.

// --- tokenizing ------------------------------------------------------------

// Depth of unclosed ()/[]/{} plus open strings — a property value continues
// onto the next line until it balances (arrays, dictionaries, multi-line strings).
function unbalanced(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return inStr || depth > 0;
}

// Parse a `[tag key=value ...]` header line. Values can be quoted strings,
// bare tokens, calls like ExtResource("1_ab"), or arrays — scanned with the
// same depth/string tracking so an embedded `]` doesn't end the header.
function parseHeaderLine(line) {
  let i = 1; // past '['
  const readWhile = (test) => { const s = i; while (i < line.length && test(line[i])) i++; return line.slice(s, i); };
  const skipWs = () => readWhile((c) => c === ' ' || c === '\t');
  const tag = readWhile((c) => c !== ' ' && c !== '\t' && c !== ']');
  const attrs = [];
  for (;;) {
    skipWs();
    if (i >= line.length || line[i] === ']') break;
    const key = readWhile((c) => c !== '=');
    i++; // '='
    const start = i;
    let depth = 0, inStr = false;
    while (i < line.length) {
      const c = line[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === '}') depth--;
      else if (c === ']') { if (depth === 0) break; depth--; }
      else if ((c === ' ' || c === '\t') && depth === 0) break;
      i++;
    }
    attrs.push({ key: key.trim(), value: line.slice(start, i) });
  }
  return { tag, attrs };
}

// --- parse / serialize -----------------------------------------------------

export function parseTscn(text) {
  const lines = text.split(/\r?\n/);
  let header = null;
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) {
      const sec = parseHeaderLine(trimmed);
      if (!header && (sec.tag === 'gd_scene' || sec.tag === 'gd_resource')) { header = sec; current = null; continue; }
      current = { ...sec, props: [] };
      sections.push(current);
      continue;
    }
    let value = line;
    while (unbalanced(value) && i + 1 < lines.length) { i++; value += '\n' + lines[i]; }
    const eq = value.indexOf('=');
    if (eq < 0) continue;
    const prop = { key: value.slice(0, eq).trim(), value: value.slice(eq + 1).trim() };
    if (current) current.props.push(prop);
  }
  return { header, sections };
}

function headerLine({ tag, attrs }) {
  return '[' + [tag, ...attrs.map((a) => `${a.key}=${a.value}`)].join(' ') + ']';
}

export function serializeTscn(doc) {
  const out = [headerLine(doc.header)];
  let prevTag = null;
  for (const sec of doc.sections) {
    // Godot lists consecutive property-less ext_resources as adjacent lines;
    // every other section is preceded by a blank line.
    if (!(prevTag === 'ext_resource' && sec.tag === 'ext_resource')) out.push('');
    out.push(headerLine(sec));
    for (const p of sec.props) out.push(`${p.key} = ${p.value}`);
    prevTag = sec.tag;
  }
  return out.join('\n') + '\n';
}

// --- value helpers ----------------------------------------------------------

export function unquote(raw) {
  if (typeof raw !== 'string' || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
}
export function quote(s) { return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"'; }

// Godot prints whole floats without a decimal point; trim float noise to six
// decimals so an edited value stays as tidy as a hand-written one.
export function fmtNum(n) {
  if (Object.is(n, -0)) n = 0;
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

// All the numbers inside a constructor-style value: Vector3(1, 2, 3),
// Transform3D(...), Color(...), or a bare number. The lookbehind keeps digits
// embedded in identifiers ("Vector3", "BoxMesh_1") from matching.
export function parseNums(raw) {
  return (String(raw).match(/(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(Number);
}

// SubResource("BoxMesh_1") / ExtResource("2_ab") → { kind, id }; Godot 3's
// bare-integer ids parse too. Anything else → null.
export function parseRef(raw) {
  const m = /^(SubResource|ExtResource)\(\s*(.+?)\s*\)$/.exec(String(raw).trim());
  if (!m) return null;
  return { kind: m[1] === 'SubResource' ? 'sub' : 'ext', id: unquote(m[2]) };
}

export function getAttr(section, key) {
  const a = section.attrs.find((x) => x.key === key);
  return a ? a.value : undefined;
}
export function attrStr(section, key) {
  const v = getAttr(section, key);
  return v === undefined ? undefined : unquote(v);
}
function setAttr(section, key, value, index) {
  const a = section.attrs.find((x) => x.key === key);
  if (a) a.value = value;
  else if (index !== undefined) section.attrs.splice(index, 0, { key, value });
  else section.attrs.push({ key, value });
}

export function getProp(section, key) {
  const p = section.props.find((x) => x.key === key);
  return p ? p.value : undefined;
}
export function setProp(section, key, value, { front = false } = {}) {
  const p = section.props.find((x) => x.key === key);
  if (p) { p.value = value; return; }
  if (front) section.props.unshift({ key, value });
  else section.props.push({ key, value });
}
export function removeProp(section, key) {
  const i = section.props.findIndex((x) => x.key === key);
  if (i >= 0) section.props.splice(i, 1);
}

// --- node tree --------------------------------------------------------------
// Nodes address each other by slash paths as Godot serializes them: the root's
// path is '.', its children are just their name ("Player"), deeper nodes are
// "Player/Arm". A node's own path doubles as its children's `parent` attribute.

export function nodeSections(doc) { return doc.sections.filter((s) => s.tag === 'node'); }

export function nodePathOf(node) {
  const parent = attrStr(node, 'parent');
  if (parent === undefined) return '.';
  const name = attrStr(node, 'name');
  return parent === '.' ? name : parent + '/' + name;
}

export function findNode(doc, path) {
  return nodeSections(doc).find((n) => nodePathOf(n) === path) || null;
}

function inSubtree(path, ancestorPath) {
  if (ancestorPath === '.') return true;
  return path === ancestorPath || path.startsWith(ancestorPath + '/');
}

// "Box", then "Box2", "Box3", … — Godot's own numbering for name collisions.
export function uniqueChildName(doc, parentPath, base) {
  const taken = new Set(
    nodeSections(doc)
      .filter((n) => attrStr(n, 'parent') === parentPath)
      .map((n) => attrStr(n, 'name')),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(base + n)) return base + n;
}

// Append a node as the last child of parentPath. Sections stay in Godot's
// depth-first order: the new node goes right after the parent's whole subtree.
// An instanced-scene node (`instance: 'ExtResource("1_x")'`) carries no type —
// its type comes from the instanced scene's root, so Godot omits the attribute.
export function addNode(doc, { parentPath, type, name, props = [], instance }) {
  const attrs = [{ key: 'name', value: quote(name) }];
  if (type !== undefined) attrs.push({ key: 'type', value: quote(type) });
  attrs.push({ key: 'parent', value: quote(parentPath) });
  if (instance !== undefined) attrs.push({ key: 'instance', value: instance });
  const node = { tag: 'node', attrs, props: props.map((p) => ({ ...p })) };
  let insertAt = -1;
  for (let i = 0; i < doc.sections.length; i++) {
    const s = doc.sections[i];
    if (s.tag === 'node' && inSubtree(nodePathOf(s), parentPath)) insertAt = i;
  }
  if (insertAt < 0) throw new Error(`parent node not found: ${parentPath}`);
  doc.sections.splice(insertAt + 1, 0, node);
  return node;
}

// Remove a node and its whole subtree, plus any signal connections into it.
export function removeNodeTree(doc, path) {
  if (path === '.') throw new Error('cannot remove the scene root');
  doc.sections = doc.sections.filter((s) => {
    if (s.tag === 'node') return !inSubtree(nodePathOf(s), path);
    if (s.tag === 'connection') {
      const from = attrStr(s, 'from'), to = attrStr(s, 'to');
      return !(from !== undefined && inSubtree(from, path)) && !(to !== undefined && inSubtree(to, path));
    }
    return true;
  });
}

// Move a node (and its whole subtree) under a new parent, renaming on a
// sibling collision like Godot does. Rewrites the subtree's parent paths and
// any connection endpoints into it, and re-slots the sections after the new
// parent's subtree so the file stays in depth-first order. Returns the node's
// new `{ path, name }`.
export function reparentNode(doc, path, newParentPath) {
  if (path === '.') throw new Error('cannot reparent the scene root');
  if (newParentPath === path || newParentPath.startsWith(path + '/')) throw new Error('cannot reparent into own subtree');
  const node = findNode(doc, path);
  if (!node) throw new Error(`node not found: ${path}`);
  const oldName = attrStr(node, 'name');
  if (attrStr(node, 'parent') === newParentPath) return { path, name: oldName };

  const name = uniqueChildName(doc, newParentPath, oldName);
  const newPath = newParentPath === '.' ? name : newParentPath + '/' + name;
  const rebase = (p) => (p === path ? newPath : newPath + p.slice(path.length));

  const subtree = doc.sections.filter((s) => s.tag === 'node' && inSubtree(nodePathOf(s), path));
  doc.sections = doc.sections.filter((s) => !subtree.includes(s));
  setAttr(node, 'name', quote(name));
  setAttr(node, 'parent', quote(newParentPath));
  for (const s of subtree) {
    if (s === node) continue;
    setAttr(s, 'parent', quote(rebase(attrStr(s, 'parent'))));
  }
  for (const s of doc.sections) {
    if (s.tag !== 'connection') continue;
    for (const key of ['from', 'to']) {
      const p = attrStr(s, key);
      if (p !== undefined && inSubtree(p, path)) setAttr(s, key, quote(rebase(p)));
    }
  }

  let insertAt = -1;
  for (let i = 0; i < doc.sections.length; i++) {
    const s = doc.sections[i];
    if (s.tag === 'node' && inSubtree(nodePathOf(s), newParentPath)) insertAt = i;
  }
  if (insertAt < 0) throw new Error(`parent node not found: ${newParentPath}`);
  doc.sections.splice(insertAt + 1, 0, ...subtree);
  return { path: newPath, name };
}

// Insert an `[ext_resource]` (or return the id of an existing one for the same
// type+path — dropping the same model twice must not duplicate the resource).
// Ids follow Godot's "<n>_<slug>" shape; sections stay grouped after the
// descriptor, before sub_resources/nodes; load_steps is kept honest.
export function addExtResource(doc, { type, path }) {
  const exts = doc.sections.filter((s) => s.tag === 'ext_resource');
  const existing = exts.find((s) => attrStr(s, 'type') === type && attrStr(s, 'path') === path);
  if (existing) return attrStr(existing, 'id');
  const ids = new Set(exts.map((s) => attrStr(s, 'id')));
  const slug = (path.split('/').pop() || 'res').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'res';
  let n = exts.length + 1;
  let id = `${n}_${slug}`;
  while (ids.has(id)) id = `${++n}_${slug}`;
  const sec = {
    tag: 'ext_resource',
    attrs: [
      { key: 'type', value: quote(type) },
      { key: 'path', value: quote(path) },
      { key: 'id', value: quote(id) },
    ],
    props: [],
  };
  let insertAt = 0;
  for (let i = 0; i < doc.sections.length; i++) {
    if (doc.sections[i].tag === 'ext_resource') insertAt = i + 1;
  }
  doc.sections.splice(insertAt, 0, sec);
  updateLoadSteps(doc);
  return id;
}

// Insert a `[sub_resource]` with a fresh unique id, keeping resource sections
// grouped before the nodes, and keep the descriptor's load_steps honest.
export function addSubResource(doc, type, props = []) {
  const ids = new Set(doc.sections.filter((s) => s.tag === 'sub_resource').map((s) => attrStr(s, 'id')));
  let id = `${type}_1`;
  for (let n = 2; ids.has(id); n++) id = `${type}_${n}`;
  const sec = {
    tag: 'sub_resource',
    attrs: [{ key: 'type', value: quote(type) }, { key: 'id', value: quote(id) }],
    props: props.map((p) => ({ ...p })),
  };
  let insertAt = 0;
  for (let i = 0; i < doc.sections.length; i++) {
    if (doc.sections[i].tag === 'ext_resource' || doc.sections[i].tag === 'sub_resource') insertAt = i + 1;
  }
  doc.sections.splice(insertAt, 0, sec);
  updateLoadSteps(doc);
  return id;
}

// load_steps = every ext/sub resource + the scene itself; Godot omits it when
// the scene alone loads. Kept as the first descriptor attribute, Godot's slot.
export function updateLoadSteps(doc) {
  const count = doc.sections.filter((s) => s.tag === 'ext_resource' || s.tag === 'sub_resource').length;
  const i = doc.header.attrs.findIndex((a) => a.key === 'load_steps');
  if (count === 0) { if (i >= 0) doc.header.attrs.splice(i, 1); return; }
  setAttr(doc.header, 'load_steps', String(count + 1), 0);
}

// --- 3D transforms ----------------------------------------------------------
// Godot serializes a Node3D transform as Transform3D(12 numbers): the basis'
// three ROWS then the origin. Basis columns are the local axes, so basis =
// rotation-matrix rows scaled per column. Both Godot and three.js are
// right-handed Y-up, so the numbers carry over with no axis conversion.

export const IDENTITY_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function serializeTransform3d(nums) {
  return `Transform3D(${nums.map(fmtNum).join(', ')})`;
}

// Rotation-matrix rows from a quaternion [x, y, z, w].
function quatToRows([x, y, z, w]) {
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}

// Rotation-matrix rows from Godot's Euler angles (radians, default YXZ order:
// R = Ry · Rx · Rz).
function eulerYXZToRows([x, y, z]) {
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    [cy * cz + sy * sx * sz, sy * sx * cz - cy * sz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [cy * sx * sz - sy * cz, sy * sz + cy * sx * cz, cy * cx],
  ];
}

function composeTransform(rows, position, scale) {
  const [sx, sy, sz] = scale;
  return [
    rows[0][0] * sx, rows[0][1] * sy, rows[0][2] * sz,
    rows[1][0] * sx, rows[1][1] * sy, rows[1][2] * sz,
    rows[2][0] * sx, rows[2][1] * sy, rows[2][2] * sz,
    position[0], position[1], position[2],
  ];
}

// A node section's local transform as the 12 Transform3D numbers, whichever
// way it was written: a full `transform`, or `position` / `rotation` (Euler) /
// `quaternion` / `scale` parts (each defaulting like Godot does).
export function transformOfNode(node) {
  const t = getProp(node, 'transform');
  if (t !== undefined) {
    const nums = parseNums(t);
    if (nums.length === 12) return nums;
  }
  const position = parseNums(getProp(node, 'position') ?? '').concat([0, 0, 0]).slice(0, 3);
  const scaleNums = parseNums(getProp(node, 'scale') ?? '');
  const scale = scaleNums.length === 3 ? scaleNums : [1, 1, 1];
  const quat = parseNums(getProp(node, 'quaternion') ?? '');
  const euler = parseNums(getProp(node, 'rotation') ?? '');
  const rows = quat.length === 4 ? quatToRows(quat)
    : euler.length === 3 ? eulerYXZToRows(euler)
      : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return composeTransform(rows, position, scale);
}

// Write a node's transform as one Transform3D, dropping any split
// position/rotation/scale props so the file has a single source of truth
// (matching what Godot's own editor writes for a moved node).
export function setNodeTransform(doc, path, nums) {
  const node = findNode(doc, path);
  if (!node) throw new Error(`node not found: ${path}`);
  for (const key of ['position', 'rotation', 'quaternion', 'scale', 'basis']) removeProp(node, key);
  setProp(node, 'transform', serializeTransform3d(nums), { front: true });
}
