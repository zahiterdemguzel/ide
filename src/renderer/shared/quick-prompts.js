// Quick prompts: the per-project list of messages the user sends to sessions over
// and over ("improve this UI", "make this model more realistic"). Stored as a plain
// `{ [projectPath]: string[] }` map. Pure data helpers, no DOM or storage, so they're
// unit-tested directly; renderer/quick-prompts.js owns the settings editor, the
// picker at the bottom of the session view, and the localStorage key.

// Trim, drop blanks and exact duplicates, keeping the user's order. Settings rows
// are edited in place, so a half-cleared row must not leave an empty prompt behind.
export function normalizePrompts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// The stored map is hand-editable JSON that outlives versions: anything not shaped
// `path -> string[]` degrades to "no prompts" rather than throwing.
export function sanitizePromptMap(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [repo, list] of Object.entries(parsed)) {
    const prompts = normalizePrompts(list);
    if (repo && prompts.length) out[repo] = prompts;
  }
  return out;
}

export function promptsForProject(map, repo) {
  return (map && repo && Array.isArray(map[repo])) ? [...map[repo]] : [];
}

// Replace one project's list, returning a NEW map. An emptied list drops the
// project so the store doesn't keep an entry for every folder ever opened.
export function withProjectPrompts(map, repo, list) {
  const next = { ...(map || {}) };
  if (!repo) return next;
  const prompts = normalizePrompts(list);
  if (prompts.length) next[repo] = prompts;
  else delete next[repo];
  return next;
}
