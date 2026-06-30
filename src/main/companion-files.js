// Godot writes sidecar files next to a resource: a `<script>.gd.uid` for every
// script and a `<asset>.<ext>.import` for every imported asset (png, glb, ...).
// The editor generates these, not the agent's edit tools, so a per-session commit
// never sees them on its own — yet the repo is broken without them. Given a
// repo-relative path the session is committing, return the sidecar paths that must
// travel with it. A sidecar has no sidecar of its own, so a path that is already a
// sidecar yields none (no `foo.gd.uid.import`).
const SIDECAR_SUFFIXES = ['.uid', '.import'];

function companionPaths(rel) {
  if (SIDECAR_SUFFIXES.some((suf) => rel.endsWith(suf))) return [];
  return SIDECAR_SUFFIXES.map((suf) => rel + suf);
}

module.exports = { companionPaths, SIDECAR_SUFFIXES };
