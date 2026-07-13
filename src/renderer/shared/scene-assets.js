import { MODEL_EXT, extOf } from './ext.js';

// Pure model for the Godot scene editor's resources panel: which of the
// project's 3D model files can be dropped into a scene, what to call them,
// their res:// paths, and whether a ready-made thumbnail exists on disk.
// Works over the flat repo-relative file list from `list-files` — no FS/DOM.

// Thumbnails are only *found*, never generated: a sibling image sharing the
// model's basename (robot.glb → robot.png) counts as its thumbnail.
const THUMB_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

// The Godot project root is the nearest ancestor directory of the scene file
// holding a project.godot — that directory is what res:// paths resolve
// against. null when no project.godot exists (a bare repo of assets).
export function godotRootOf(sceneFile, files) {
  const set = new Set(files);
  let dir = sceneFile.includes('/') ? sceneFile.slice(0, sceneFile.lastIndexOf('/')) : '';
  for (;;) {
    if (set.has(dir ? dir + '/project.godot' : 'project.godot')) return dir;
    if (!dir) return null;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

// Every droppable model reachable from the scene's project: repo-relative
// `file`, display `name` (basename, no extension), repo-relative `thumb` (or
// null), and the `res://` path Godot will load it by. Models outside the
// project root are excluded (Godot can't reference them); with no
// project.godot the repo root stands in as the res:// root, best-effort.
export function modelEntries(sceneFile, files) {
  const set = new Set(files);
  const root = godotRootOf(sceneFile, files) ?? '';
  const prefix = root ? root + '/' : '';
  const out = [];
  for (const f of files) {
    if (!MODEL_EXT.has(extOf(f))) continue;
    if (prefix && !f.startsWith(prefix)) continue;
    const stem = f.replace(/\.[^.]+$/, '');
    const base = f.split('/').pop();
    out.push({
      file: f,
      name: base.replace(/\.[^.]+$/, ''),
      thumb: THUMB_EXTS.map((e) => `${stem}.${e}`).find((t) => set.has(t)) || null,
      res: 'res://' + f.slice(prefix.length),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

// A model filename as a legal Godot node name (no . / : @ % ").
export function nodeNameFor(name) {
  return name.replace(/[./:@%"]/g, '_') || 'Scene';
}
