// Pure, DOM-free rules for the sidebar's "send to sessions" dialog: which filter
// group each session state falls under, and which sessions a send reaches.

// The checkbox groups, in the order the dialog lists them.
export const BROADCAST_KINDS = ['idle', 'working', 'needs-input', 'interrupted'];

// Kinds ticked when the dialog first opens: a session that's mid-turn already has
// a task, so sending to it is opt-in.
export const DEFAULT_BROADCAST_KINDS = ['idle', 'needs-input', 'interrupted'];

// Background agents still count as working; every settled state (completed,
// pushed, a fresh idle session) is "idle".
export function broadcastKind(state) {
  if (state === 'working' || state === 'bg-agents') return 'working';
  if (state === 'needs-input' || state === 'interrupted') return state;
  return 'idle';
}

// Active sessions of the open project (`repo` undefined = no project filter).
function activeInRepo(rows, repo) {
  return rows.filter((s) => !s.archived && (repo === undefined || s.repo === repo));
}

// How many active sessions of the open project fall under each kind.
export function countByKind(rows, repo) {
  const counts = Object.fromEntries(BROADCAST_KINDS.map((k) => [k, 0]));
  for (const s of activeInRepo(rows, repo)) counts[broadcastKind(s.state)]++;
  return counts;
}

// The ids a send with these ticked kinds reaches.
export function broadcastTargetIds(rows, repo, kinds) {
  const wanted = new Set(kinds);
  return activeInRepo(rows, repo).filter((s) => wanted.has(broadcastKind(s.state))).map((s) => s.id);
}
