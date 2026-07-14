// The chat wire: the shape of a conversation as main sends it (see src/main/chat.js),
// and the two calls the composer makes.
//
// The phone never sees the session's terminal. Messages come from Claude Code's own
// transcript, and a message is *upserted by uuid* rather than appended — a tool's
// result lands in a later push than its call, and patches the message it belongs to.
import { Connection } from './connection';

export type ToolStatus = 'running' | 'ok' | 'error';

export type Block =
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'image' }
  | { t: 'tool'; id: string; name: string; title: string; status: ToolStatus; output: string };

export type Message = { uuid: string; role: 'user' | 'assistant'; ts: string; blocks: Block[] };

// The question the TUI is blocked on (a permission prompt, usually). It exists only
// in the terminal, so main lifts it out and we render it as a card in the chat.
export type Ask = { question: string; options: { key: string; label: string }[] };

export type Transcript = { messages: Message[]; seq: number; ask: Ask | null };

export type SlashCommand = { name: string; description: string; source: 'builtin' | 'user' | 'project' };

// Fold a push into the list we're holding: replace the message with this uuid, or
// append it. Returns a new array only when something actually changed, so a re-render
// is never wasted on a repeat.
export function upsert(list: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return list;
  const next = list.slice();
  for (const m of incoming) {
    const i = next.findIndex((x) => x.uuid === m.uuid);
    if (i === -1) next.push(m); else next[i] = m;
  }
  return next;
}

// Hand the desktop an image and get back the path it wrote it to. Claude reads an
// image file exactly as it reads a source file, so a path is all a prompt needs.
export async function uploadImage(conn: Connection, name: string, base64: string): Promise<string> {
  const r = await conn.req<{ path: string }>('save-attachment', { name, data: base64 });
  return r.path;
}

// Type a message into the session and submit it. Main owns the timing (the TUI needs
// a beat between the text and the Enter), so this is one call.
export async function sendPrompt(conn: Connection, id: string, text: string, images: string[] = []) {
  const r = await conn.req<{ ok: boolean; error?: string }>('send-prompt', { id, text, images });
  if (!r?.ok) throw new Error(r?.error || 'Could not send the message');
}

// A session's answer to a permission prompt is a keystroke, not a message: the TUI
// menu takes the option's number.
export function answerAsk(conn: Connection, id: string, key: string) {
  conn.send('pty-input', { id, data: key });
}
