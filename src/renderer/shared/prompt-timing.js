// When to type a queued first message into a freshly spawned session. Claude's TUI
// isn't ready the instant its PTY starts: its first output means it's painting, and
// the input box takes about a second more. sessions.js owns the PTY writes.

// From the session's first output to an input box that takes keystrokes.
export const TUI_READY_MS = 1000;

// How long to wait before typing, or null while the session hasn't printed anything
// yet (then the first output starts the clock). A session that has been up for a
// while — one spawned in the background during a voice hold — is typed into at once.
export function promptTypingDelay(firstOutputAt, now) {
  if (typeof firstOutputAt !== 'number') return null;
  return Math.max(0, TUI_READY_MS - (now - firstOutputAt));
}

// The gap between typing the text and pressing Enter. Bundling "\r" with the text
// submits before the TUI has ingested a multi-line paste, so the prompt fires
// half-typed; the gap scales with length because long prompts take longer to ingest.
export function promptSubmitDelay(text) {
  return Math.min(3000, 400 + (text || '').length / 4);
}
