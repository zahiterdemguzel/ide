// Tappable web links and file paths in the chat.
//
// Detection is a port of the desktop terminal's (src/renderer/shared/terminal-links-parse.js):
// it deliberately over-matches — any token with a separator or a file extension — and
// the desktop decides which of those are real files (`resolve-chat-paths`). Only
// those are drawn as links, so "and/or" or "Node.js" stay plain text. Answers are
// asked for in one batch per render pass and cached for the life of the chat.
import React, { createContext, useContext, useEffect, useReducer } from 'react';
import { Linking, Text } from 'react-native';

export type FileTarget = { path: string; line: number };

const URL_RE = /\bhttps?:\/\/[^\s)<>"'`]+/gi;
const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)*(?::\d+(?::\d+)?|#L\d+)?/g;
// A sentence ending right after a URL leaves its full stop or comma on the match.
const URL_TRAILING = /[.,;:!?]+$/;

export function looksLikePath(token: string): boolean {
  const core = token.replace(/(?::\d+(?::\d+)?|#L\d+)$/, '');
  if (core.length < 2 || /\s/.test(core)) return false;
  if (/[\\/]/.test(core)) return /[\w]/.test(core);
  return /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(core);
}

export type Segment = { kind: 'text' | 'url' | 'path'; text: string };

// Cut a run of plain text into text / URL / path-candidate pieces, URLs first so a
// URL's own path is never read as a file.
export function splitLinks(text: string): Segment[] {
  const spans: { start: number; end: number; kind: 'url' | 'path' }[] = [];
  const taken = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start);
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(URL_TRAILING, '');
    spans.push({ start: m.index!, end: m.index! + raw.length, kind: 'url' });
  }
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[0].replace(/[.:]+$/, '');
    const start = m.index!, end = start + raw.length;
    if (looksLikePath(raw) && !taken(start, end)) spans.push({ start, end, kind: 'path' });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) out.push({ kind: 'text', text: text.slice(pos, s.start) });
    out.push({ kind: s.kind, text: text.slice(s.start, s.end) });
    pos = s.end;
  }
  if (pos < text.length) out.push({ kind: 'text', text: text.slice(pos) });
  return out;
}

// A dev server on the desktop's own loopback is unreachable from the phone's
// browser, but the remote Browser tab runs *on* the desktop and can open it.
export function isDesktopLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i.test(url);
}

type AskDesktop = (paths: string[]) => Promise<Record<string, FileTarget>>;

// One per open chat: remembers each token's answer and batches the questions.
export class PathResolver {
  private known = new Map<string, FileTarget | null>();
  private queued = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ask: AskDesktop) {}

  get(token: string): FileTarget | null {
    return this.known.get(token) ?? null;
  }

  watch(token: string, onChange: () => void): () => void {
    let set = this.listeners.get(token);
    if (!set) this.listeners.set(token, (set = new Set()));
    set.add(onChange);
    if (!this.known.has(token)) this.enqueue(token);
    return () => {
      set!.delete(onChange);
      if (!set!.size) this.listeners.delete(token);
    };
  }

  // The open folder changed: every answer was relative to the old one.
  reset() {
    this.known.clear();
    for (const token of this.listeners.keys()) this.enqueue(token);
  }

  private enqueue(token: string) {
    this.queued.add(token);
    // A render pass mounts many links at once; ask about all of them together.
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 30);
  }

  private async flush() {
    this.timer = null;
    const batch = [...this.queued];
    this.queued.clear();
    if (!batch.length) return;
    let resolved: Record<string, FileTarget> = {};
    try {
      resolved = await this.ask(batch);
    } catch {
      return; // socket dropped — unknown tokens are asked again when they remount
    }
    for (const token of batch) {
      const target = resolved[token] ?? null;
      this.known.set(token, target);
      if (target) this.listeners.get(token)?.forEach((fn) => fn());
    }
  }
}

export type ChatLinks = {
  resolver: PathResolver;
  openFile: (target: FileTarget) => void;
  openUrl: (url: string) => void;
};

export const ChatLinksContext = createContext<ChatLinks | null>(null);

function useFileTarget(token: string): FileTarget | null {
  const links = useContext(ChatLinksContext);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => links?.resolver.watch(token, rerender), [links, token]);
  return links?.resolver.get(token) ?? null;
}

export function openUrlFallback(url: string) {
  Linking.openURL(url).catch(() => {});
}

export function UrlLink({ url, children, style }: { url: string; children?: React.ReactNode; style: any }) {
  const links = useContext(ChatLinksContext);
  const open = () => (links ? links.openUrl(url) : openUrlFallback(url));
  return <Text style={style} onPress={open}>{children ?? url}</Text>;
}

// A path-looking token: a link once the desktop confirms it is a file in the open
// folder, plain (in `plainStyle`) until then and forever if it isn't.
export function PathLink({ token, children, style, plainStyle }: {
  token: string; children?: React.ReactNode; style: any; plainStyle?: any;
}) {
  const links = useContext(ChatLinksContext);
  const target = useFileTarget(token);
  if (!target || !links) return <Text style={plainStyle}>{children ?? token}</Text>;
  return <Text style={style} onPress={() => links.openFile(target)}>{children ?? token}</Text>;
}

// Plain text with its URLs and existing file paths made tappable.
export function LinkedText({ text, linkStyle }: { text: string; linkStyle: any }) {
  return (
    <>
      {splitLinks(text).map((seg, i) => {
        if (seg.kind === 'url') return <UrlLink key={i} url={seg.text} style={linkStyle} />;
        if (seg.kind === 'path') return <PathLink key={i} token={seg.text} style={linkStyle} />;
        return <Text key={i}>{seg.text}</Text>;
      })}
    </>
  );
}
