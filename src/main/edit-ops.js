// Pure functions that turn file-editing tool calls into replayable ops and
// replay / de-apply them, so a single session's work can be committed or
// reverted independently — even when two sessions edited the same file.

// Turn one file-editing tool call into a replayable op, so we can later rebuild
// "HEAD + only this session's edits" for the file. An op is one of:
//   { t: 'write', content }                  full-content write (Write tool)
//   { t: 'edit',  old, new, all }            single string replacement (Edit)
//   { t: 'multi', edits: [{old,new,all}] }   ordered replacements (MultiEdit)
//   { t: 'opaque' }                          un-replayable (NotebookEdit) -> fall back
function editOp(toolName, ti) {
  if (toolName === 'Write') return { t: 'write', content: ti.content || '' };
  if (toolName === 'Edit') return { t: 'edit', old: ti.old_string ?? '', new: ti.new_string ?? '', all: !!ti.replace_all };
  if (toolName === 'MultiEdit') {
    return { t: 'multi', edits: (ti.edits || []).map((e) => ({ old: e.old_string ?? '', new: e.new_string ?? '', all: !!e.replace_all })) };
  }
  return { t: 'opaque' };
}

// Replay a session's ops onto a base string. Returns { content, clean } where
// clean=false means an edit's old_string wasn't found (the other session moved
// it, or an opaque op) — caller then falls back to the whole working file.
function replayEdits(base, ops) {
  let s = base, clean = true;
  for (const op of ops) {
    if (op.t === 'opaque') { clean = false; continue; }
    if (op.t === 'write') { s = op.content; continue; }
    for (const e of (op.t === 'multi' ? op.edits : [op])) {
      if (!e.old) { s += e.new; continue; } // insertion with empty old_string
      if (!s.includes(e.old)) { clean = false; continue; }
      s = e.all ? s.split(e.old).join(e.new)
        : s.slice(0, s.indexOf(e.old)) + e.new + s.slice(s.indexOf(e.old) + e.old.length);
    }
  }
  return { content: s, clean };
}

// De-apply a session's ops from the current working string (the inverse of
// replayEdits) — back out just this session's substitutions, leaving any other
// session's edits to the same file untouched. Ops are inverted newest-first:
// for an Edit, new->old. Returns { content, clean }; clean=false means an op
// can't be safely inverted (a full Write or opaque op has no stored pre-image,
// a pure deletion can't be relocated, or the new_string is gone) — caller then
// decides whether a hard reset to HEAD is safe.
function inverseEdits(working, ops) {
  let s = working, clean = true;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.t === 'write' || op.t === 'opaque') { clean = false; continue; }
    const edits = op.t === 'multi' ? op.edits : [op];
    for (let j = edits.length - 1; j >= 0; j--) {
      const e = edits[j];
      if (!e.new) { clean = false; continue; } // pure deletion: can't relocate the old text
      if (!s.includes(e.new)) { clean = false; continue; }
      s = e.all ? s.split(e.new).join(e.old)
        : s.slice(0, s.indexOf(e.new)) + e.old + s.slice(s.indexOf(e.new) + e.new.length);
    }
  }
  return { content: s, clean };
}

module.exports = { editOp, replayEdits, inverseEdits };
