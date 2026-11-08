// Pure, DOM-free rules for "double session": two session terminals side by side.
// The split is an ordered pair of ids [leftId, rightId], or null for the usual
// single terminal. The focused (active) session is always one of the pair.

// Only sessions that share the project tree can sit side by side. A worktree
// session re-points the git pane, explorer and run toolbar at its own checkout,
// so two of them on screen would leave those panels describing only one.
export function canSplitSession(s) {
  return !!s && !s.worktree && !s.archived;
}

// The split after a click on a session row. `shift` is whether Shift was held.
// - Clicking a session already on screen keeps the split (it just takes focus).
// - A plain click elsewhere returns to a single terminal.
// - Shift+click opens the clicked session beside the active one; with a split
//   already open it replaces the pane that isn't focused.
// - A Shift+click that can't split (ineligible session, or nothing to pair it
//   with) behaves like a plain click.
export function splitAfterClick({ split, activeId, clickedId, shift, eligible }) {
  if (split && split.includes(clickedId)) return split;
  if (!shift) return null;
  if (!activeId || clickedId === activeId) return null;
  if (!eligible(activeId) || !eligible(clickedId)) return null;
  if (split && split.includes(activeId)) return split.map((id) => (id === activeId ? id : clickedId));
  return [activeId, clickedId];
}

// The other pane of the split, or null when `id` isn't in it.
export function splitPartner(split, id) {
  if (!split || !split.includes(id)) return null;
  return split.find((other) => other !== id) || null;
}

// Whether the split still holds once `focusId` is selected: the focused session
// must be one of the pair, and both must still be eligible (one may have been
// archived or closed from elsewhere, e.g. a paired phone).
export function splitStillValid(split, focusId, eligible) {
  return !!split && split.includes(focusId) && split.every(eligible);
}
