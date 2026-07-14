// WebSocket client for the desktop's remote server (server/ws-server.js).
// The protocol mirrors the desktop's IPC 1:1: req/res with id correlation,
// fire-and-forget sends, and ev pushes. Reconnects with backoff and re-auths
// using the stored device token.
//
// It is given the desktop's endpoints in dial order (LAN, then the cloud relay —
// see pairing.ts) and works down the list until one answers. The desktop speaks
// the same protocol on both, so nothing below this line knows which one is live.

import { DIAL_TIMEOUT_MS } from './config';

export type Ev = { t: 'ev'; ch: string; payload: unknown };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type ConnectionState = 'connecting' | 'pairing' | 'ready' | 'closed' | 'error';

export class Connection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private retry = 0;
  private idx = 0; // which endpoint we are dialling
  private closedByUser = false;
  state: ConnectionState = 'closed';
  deviceId: string | null = null;
  url: string;

  constructor(
    public urls: string[],
    private auth: { deviceToken?: string; pairToken?: string; deviceName?: string },
    private onDeviceToken?: (token: string) => void,
  ) {
    this.url = urls[0];
  }

  connect() {
    this.closedByUser = false;
    this.setState('connecting');
    this.url = this.urls[this.idx] ?? this.urls[0];
    const ws = new WebSocket(this.url);
    this.ws = ws;

    // Reached `ready` on *this* socket. Distinguishes "that endpoint is dead, try
    // the next" from "a working link dropped, reconnect to it".
    let live = false;
    const markLive = () => { live = true; clearTimeout(dialTimer); };
    // An endpoint that refuses connects fast, but one that black-holes packets —
    // the LAN address while the phone is on cellular, typically — would hang here
    // forever. Give each a bounded turn.
    const dialTimer = setTimeout(() => { if (!live) ws.close(); }, DIAL_TIMEOUT_MS);

    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      switch (msg.t) {
        case 'hello':
          if (this.auth.deviceToken) {
            ws.send(JSON.stringify({ t: 'auth', deviceToken: this.auth.deviceToken }));
          } else if (this.auth.pairToken) {
            this.setState('pairing');
            ws.send(JSON.stringify({ t: 'pair', pairToken: this.auth.pairToken, deviceName: this.auth.deviceName ?? 'Phone' }));
          }
          return;
        case 'paired':
          this.auth = { deviceToken: msg.deviceToken };
          this.deviceId = msg.deviceId;
          this.onDeviceToken?.(msg.deviceToken);
          this.retry = 0;
          markLive();
          this.setState('ready');
          return;
        case 'auth-ok':
          this.deviceId = msg.deviceId;
          this.retry = 0;
          markLive();
          this.setState('ready');
          return;
        case 'auth-err':
          this.closedByUser = true; // don't retry a bad credential in a loop
          this.setState('error');
          ws.close();
          return;
        case 'res': {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
          return;
        }
        case 'ev':
          this.listeners.get(msg.ch)?.forEach((fn) => fn(msg.payload));
          return;
        case 'fwd-ok': {
          const w = this.fwdWaiters.get(msg.port);
          this.fwdWaiters.delete(msg.port);
          w?.resolve(msg.url);
          return;
        }
        case 'fwd-err': {
          const w = this.fwdWaiters.get(msg.port);
          this.fwdWaiters.delete(msg.port);
          w?.reject(new Error(msg.error));
          return;
        }
      }
    };

    ws.onclose = () => {
      clearTimeout(dialTimer);
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      for (const w of this.fwdWaiters.values()) w.reject(new Error('connection closed'));
      this.fwdWaiters.clear();
      if (this.closedByUser) { if (this.state !== 'error') this.setState('closed'); return; }
      this.setState('connecting');

      let delay: number;
      if (live) {
        // A link that worked and dropped. Start the sweep again from the top rather
        // than clinging to this endpoint: the phone may have changed networks, and
        // the one that just died may not be the right one any more.
        this.idx = 0;
        this.retry = 0;
        delay = 500;
      } else if (this.idx + 1 < this.urls.length) {
        this.idx++; // that endpoint never answered — try the next one at once
        delay = 0;
      } else {
        this.idx = 0; // none of them answered; wait before sweeping the list again
        delay = Math.min(1000 * 2 ** this.retry++, 15000);
      }
      setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
    this.setState('closed');
  }

  req<T = unknown>(ch: string, args?: unknown): Promise<T> {
    if (this.state !== 'ready' || !this.ws) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ t: 'req', id, ch, args }));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  private fwdWaiters = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>();

  // Forward desktop localhost:<port> to the LAN; resolves to the URL to open
  // in the phone's browser.
  forwardPort(port: number): Promise<string> {
    if (this.state !== 'ready' || !this.ws) return Promise.reject(new Error('not connected'));
    this.ws.send(JSON.stringify({ t: 'fwd-open', port }));
    return new Promise((resolve, reject) => this.fwdWaiters.set(port, { resolve, reject }));
  }

  closeForward(port: number) {
    if (this.state === 'ready' && this.ws) this.ws.send(JSON.stringify({ t: 'fwd-close', port }));
  }

  send(ch: string, args?: unknown) {
    if (this.state === 'ready' && this.ws) this.ws.send(JSON.stringify({ t: 'send', ch, args }));
  }

  on(ch: string, fn: (payload: any) => void): () => void {
    if (!this.listeners.has(ch)) this.listeners.set(ch, new Set());
    this.listeners.get(ch)!.add(fn);
    return () => this.listeners.get(ch)?.delete(fn);
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.stateListeners.forEach((fn) => fn(s));
  }
}
