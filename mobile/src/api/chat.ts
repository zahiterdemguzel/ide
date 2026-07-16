// The chat wire: the shape of a conversation as main sends it (see src/main/chat.js),
// and the two calls the composer makes.
//
// The phone never sees the session's terminal. Messages come from Claude Code's own
// transcript, and a message is *upserted by uuid* rather than appended — a tool's
// result lands in a later push than its call, and patches the message it belongs to.
import { Connection } from './connection';

export type ToolStatus = 'running' | 'ok' | 'error';

// An Edit/Write call arrives with a diff of what it changed: signed lines with the
// line number each lands on, plus the +N/−N totals for the header badge. The call
// itself carries a diff built from its input (`n: 0` — no line number yet); the
// result upgrades it to the CLI's own patch with real numbers.
export type DiffLine = { n: number; sign: '+' | '-' | ' '; text: string };
export type Diff = { added: number; removed: number; lines: DiffLine[] };

export type Block =
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  | { t: 'image' }
  | { t: 'tool'; id: string; name: string; title: string; status: ToolStatus; output: string; diff?: Diff };

export type Message = { uuid: string; role: 'user' | 'assistant'; ts: string; blocks: Block[] };

// The question the session is blocked on — one of Claude's own multiple-choice questions
// (which can carry several at once) or a permission prompt. It's drawn in the terminal,
// which the phone never sees, so main reads it off the hook that announced it and pushes
// it here as a card. `customKey` is set when the question will also accept words instead
// of an option, which is the whole point of a chat over a menu: you are never stuck
// choosing between someone else's answers.
export type AskOption = { key: string; label: string; description: string };
export type AskQuestion = {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOption[];
  customKey: string;
};
export type Ask = { kind: 'question' | 'permission'; questions: AskQuestion[]; submitKey: string };

// One answer per question: an option's key, several keys when the question is
// multiSelect, or words typed instead of picking any.
export type Answer = { key?: string; keys?: string[]; text?: string };

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

// An attached image is handed to Claude as a path on a line of its own (see chat.js),
// so a user message's *text* and its *attachments* are the same string until we split
// them apart.
const PATH_LINE = /^"?([a-zA-Z]:[\\/]|\/)[^\n]*\.(png|jpe?g|gif|webp|heic)"?$/i;

export function messageText(m: Message): string {
  return m.blocks.filter((b) => b.t === 'text').map((b) => (b as { text: string }).text).join('\n');
}

export function splitAttachments(text: string): { said: string; files: number } {
  const lines = text.split('\n');
  const isPath = (l: string) => PATH_LINE.test(l.trim());
  return {
    said: lines.filter((l) => !isPath(l)).join('\n').trim(),
    files: lines.filter(isPath).length,
  };
}

// A message the phone shows the moment you hit send, before the desktop has echoed it
// back. It has to wait for the upload, the keystrokes into the TUI and Claude's write
// to the transcript — a second or more, which is far too long for a tapped message to
// stay invisible. It carries no uuid from the transcript, so it gets its own.
export type Pending = Message & { pending: true };

let n = 0;

export function pendingMessage(text: string, images: number, now = new Date()): Pending {
  n += 1;
  const blocks: Block[] = [];
  for (let i = 0; i < images; i += 1) blocks.push({ t: 'image' });
  if (text) blocks.push({ t: 'text', text });
  return { uuid: `pending:${n}`, role: 'user', ts: now.toISOString(), blocks, pending: true };
}

// Retire the pending copies the transcript has caught up with. The real entry is the
// text we sent, so that text is the identity we match on — the uuids can't be.
export function settle(pending: Pending[], incoming: Message[]): Pending[] {
  if (!pending.length) return pending;
  const said = incoming.filter((m) => m.role === 'user').map((m) => splitAttachments(messageText(m)).said);
  if (!said.length) return pending;
  const next = pending.filter((p) => !said.includes(splitAttachments(messageText(p)).said));
  return next.length === pending.length ? pending : next;
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

// Answer the question — every question in it, at once. The box on screen is a real menu,
// so main replays the answers as the keystrokes a person would have pressed, and owns
// the timing between them.
export async function answerAsk(conn: Connection, id: string, answers: Answer[]) {
  const r = await conn.req<{ ok: boolean; error?: string }>('answer-ask', { id, answers });
  if (!r?.ok) throw new Error(r?.error || 'Could not answer');
}
