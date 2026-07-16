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

// Resolve the blob a session should commit for one text-edited file. Replay its
// ops onto the committed (HEAD) `base`; if that can't be done cleanly (the other
// session moved the text, or an opaque op), fall back to the current `working`
// file. Returns the content to commit, or `null` when there is nothing to commit:
//   - `working` is null (the file is gone), or
//   - the resolved content is byte-identical to `base` — an EMPTY PATCH.
// An empty patch is a file the session touched but whose net effect against HEAD
// is nothing (it edited then undid the change, or rewrote identical text). The
// caller must drop these so the commit — and the "Commit N files" count — never
// counts phantom changes that would commit nothing.
function commitContent(base, ops, working) {
  const { content, clean } = replayEdits(base, ops);
  const resolved = clean ? content : working;
  if (resolved == null || resolved === base) return null;
  return resolved;
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

// Added/removed line counts for a session's ops, for the "+124 −38" pill on a
// session row.
//
// Counted from the ops themselves rather than from `git diff`, for two reasons.
// The cheap one: the sessions list is paged and polled, and the ops are already in
// memory, so this costs nothing. The real one: a working-tree diff is GLOBAL and
// cannot tell two sessions apart (see the fileOps note in sessions.js), while ops
// are per-session by construction — so this is the only source that can attribute
// lines to the session that actually wrote them.
//
// The count is a magnitude, not a patch stat. Two ops touching the same lines are
// counted twice (there is no base to collapse them against), and a `write` has no
// pre-image, so its removals are invisible and its whole content reads as added.
// Files tracked via `fileOps` (binary, renamed, deleted) carry no line counts at
// all and contribute nothing.
function diffStat(ops) {
  let added = 0, removed = 0;
  for (const op of ops) {
    if (op.t === 'opaque') continue;
    if (op.t === 'write') { added += lines(op.content).length; continue; }
    for (const e of (op.t === 'multi' ? op.edits : [op])) {
      const d = diffPair(e.old, e.new);
      added += d.added;
      removed += d.removed;
    }
  }
  return { added, removed };
}

function lines(s) {
  return s === '' ? [] : s.split('\n');
}

// Line delta between two versions of a hunk, ignoring the lines they share at each
// end — so re-indenting one line inside a 40-line replacement reads as 1 changed
// line, not 40. Anything the common prefix/suffix doesn't cover is counted whole;
// this deliberately doesn't LCS the middle, which is what keeps it O(n).
function diffPair(oldStr, newStr) {
  const a = lines(oldStr), b = lines(newStr);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;
  return { removed: a.length - head - tail, added: b.length - head - tail };
}

module.exports = { editOp, replayEdits, commitContent, inverseEdits, diffStat };
