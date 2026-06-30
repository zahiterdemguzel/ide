// Collect the editable textures of a loaded model's scene graph. Pure traversal
// over a duck-typed graph (only `.children`, `.isMesh`, `.material`, and the
// material's map slots are read), so it's unit-testable without three.js.
//
// The 3D editor's texture panel only adjusts the **base-color** map (`material.map`):
// it's the one sRGB, photographic image where brightness/contrast/saturation make
// sense. Normal/roughness/metalness/AO maps hold linear, non-photographic data
// those controls would corrupt, so they're deliberately excluded here.
const COLOR_SLOTS = ['map'];

// Returns one entry per distinct texture — `{ texture, label, colorSpace, slots }`
// — deduped by object identity so a texture shared across several materials is a
// single entry (editing it updates every user at once). `slots` lists every
// `{ material, key }` the texture is bound to. `label` carries a `×N` suffix when
// a texture feeds more than one slot, so a shared edit isn't a surprise.
export function enumerateTextures(root, slotKeys = COLOR_SLOTS) {
  const byTexture = new Map();
  forEachMesh(root, (mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const key of slotKeys) {
        const texture = material[key];
        if (!texture) continue;
        let entry = byTexture.get(texture);
        if (!entry) {
          entry = { texture, colorSpace: texture.colorSpace, slots: [], label: '' };
          byTexture.set(texture, entry);
        }
        entry.slots.push({ material, key });
      }
    }
  });

  const entries = [...byTexture.values()];
  entries.forEach((entry, i) => {
    const base = entry.texture.name || entry.slots[0].material.name || `Texture ${i + 1}`;
    entry.label = entry.slots.length > 1 ? `${base} ×${entry.slots.length}` : base;
  });
  return entries;
}

function forEachMesh(obj, fn) {
  if (!obj) return;
  if (obj.isMesh) fn(obj);
  if (obj.children) for (const child of obj.children) forEachMesh(child, fn);
}
