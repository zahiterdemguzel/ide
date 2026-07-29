// Minimal reader for project.godot — an INI file whose section bodies use
// slash-separated keys (`[display]` + `window/size/viewport_width = 1152`).
// Only the handful of keys the UI editor needs are interpreted; everything else
// is kept as its raw source string. No FS/DOM here so it stays unit-testable.

// Godot 4's project-creation default. A project that never touched the setting
// writes no key at all, so this is what the editor must assume.
export const DEFAULT_VIEWPORT = { width: 1152, height: 648 };

export function parseProjectGodot(text) {
  const sections = new Map();
  let current = new Map();
  sections.set('', current); // pre-[section] keys (config_version) live here
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      current = sections.get(name) || new Map();
      sections.set(name, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return { sections };
}

export function projectValue(cfg, section, key) {
  const sec = cfg && cfg.sections && cfg.sections.get(section);
  return sec ? sec.get(key) : undefined;
}

function unquote(raw) {
  if (typeof raw !== 'string') return raw;
  return raw[0] === '"' && raw[raw.length - 1] === '"' ? raw.slice(1, -1) : raw;
}

// The design resolution every root Control anchors against.
export function viewportSize(cfg) {
  const num = (key, def) => {
    const n = Number(projectValue(cfg, 'display', key));
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    width: num('window/size/viewport_width', DEFAULT_VIEWPORT.width),
    height: num('window/size/viewport_height', DEFAULT_VIEWPORT.height),
  };
}

// The project-wide default theme (`gui/theme/custom`), a res:// path or null.
export function defaultThemeRes(cfg) {
  const v = unquote(projectValue(cfg, 'gui', 'theme/custom'));
  return v ? v : null;
}
