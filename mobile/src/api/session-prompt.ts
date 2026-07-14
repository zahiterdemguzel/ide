// Start a Claude session pre-loaded with a prompt, then submit it — the mobile
// twin of newSessionWithPrompt + the pendingPrompts drain in src/renderer/sessions.js.
//
// The prompt can't be sent the moment new-session resolves: Claude's TUI hasn't
// painted its input box yet and the keystrokes would land nowhere. The desktop waits
// for the session's first pty-data (proof the TUI is painting), types after a beat,
// and sends Enter as a SEPARATE write — bundling "\r" with the text submits before
// the TUI has finished ingesting a multi-line paste, firing the prompt half-typed.
// Same timings here, for the same reasons.
import { Connection } from './connection';

const TYPE_DELAY_MS = 1000;
const ENTER_DELAY_MS = 1400;

// We can only subscribe to pty-data once new-session has told us the id, so a first
// chunk emitted in that window is missed. The desktop survives the same gap because
// its TUI keeps repainting; over a socket, don't bet on a second chunk arriving —
// type anyway once the PTY has plainly had time to come up.
const FALLBACK_MS = 3000;

type NewSession = { id?: string; error?: string };

// Queue `text` into a session that is starting up: type it once the TUI paints, then
// submit. Fires at most once, whichever trigger wins.
export function primePrompt(conn: Connection, id: string, text: string) {
  let sent = false;
  const submit = () => {
    if (sent) return;
    sent = true;
    off();
    clearTimeout(fallback);
    setTimeout(() => conn.send('pty-input', { id, data: text }), TYPE_DELAY_MS);
    setTimeout(() => conn.send('pty-input', { id, data: '\r' }), ENTER_DELAY_MS);
  };
  const off = conn.on('pty-data', (p: { id: string }) => { if (p?.id === id) submit(); });
  const fallback = setTimeout(submit, FALLBACK_MS);
}

// Create a session in the open project and prime it with `text`. Returns the new
// session's id so the caller can navigate to its terminal. Throws with the desktop's
// reason on failure: new-session is guard()ed on main, so a failure comes back as a
// *successful* response carrying { error }, never a rejection.
export async function newSessionWithPrompt(conn: Connection, text: string): Promise<string> {
  const r = await conn.req<NewSession>('new-session', { cols: 80, rows: 30 });
  if (!r?.id) throw new Error(r?.error || 'Could not start a session');
  primePrompt(conn, r.id, text);
  return r.id;
}
