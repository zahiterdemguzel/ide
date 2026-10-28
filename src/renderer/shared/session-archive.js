// Pure, DOM-free rules for archiving sessions from the sidebar.

// States in which a session is still doing something on its own (or is blocked
// on a question for the user), so a bulk "clear" must leave it alone.
const BUSY_STATES = new Set(['working', 'bg-agents', 'needs-input']);

export function isSessionBusy(state) {
  return BUSY_STATES.has(state);
}

// Which archived value a row should adopt from main's sessions-changed push.
// The desktop flips a row the moment the user clicks; main confirms with its own
// broadcast. Archiving several rows quickly means a push sent after the first
// archive (but before main handled the next) still says the later ones are
// active — adopting that would pop them back into the Active tab, and selecting
// one there resumes it, un-archiving it for real. So while a local change is in
// flight (`pending` is a boolean), keep the local value until main agrees.
// Returns { archived, pending } — `pending` is cleared (undefined) once confirmed.
export function reconcileArchived(local, pending, remote) {
  if (pending === undefined) return { archived: remote, pending: undefined };
  if (remote === pending) return { archived: remote, pending: undefined };
  return { archived: local, pending };
}
