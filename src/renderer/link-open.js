// Resolve a clicked Ctrl+click link (a file path or web URL) and route it to the
// right center-pane view. Shared by the terminal (terminal-links.js) and the file
// editor (viewer/file.js) so both open links identically. center.js is imported
// lazily to keep this out of the file.js ↔ center.js module cycle.
//
// `baseDir` is the absolute directory relative paths resolve against (a terminal's
// cwd, or the open file's own folder) — it can differ from the currently open
// folder, so callers pass it explicitly.
export async function openLink(kind, raw, baseDir) {
  const { showWeb, openFromTree } = await import('./viewer/center.js');
  if (kind === 'url') { showWeb(raw); return; }
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw); // split a trailing :line[:col]
  const p = m ? m[1] : raw;
  const line = m ? Number(m[2]) : null;
  const r = await window.api.resolveLinkPath(p, baseDir);
  if (!r || !r.ok) return;
  if (r.isDir) { window.api.openExternal(r.abs); return; } // OS file browser
  if (!r.isFile) return;
  if (r.inRepo) openFromTree(r.rel, line ? { line, term: null } : null);
  else window.api.openExternal(r.abs);
}
