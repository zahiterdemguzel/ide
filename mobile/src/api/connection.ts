// WebSocket client for the desktop, reached over the cloud relay (server/relay.js).
// The protocol mirrors the desktop's IPC 1:1: req/res with id correlation,
// fire-and-forget sends, and ev pushes. Reconnects to the relay with backoff and
// re-auths using the stored device token.

export type Ev = { t: 'ev'; ch: string; payload: unknown };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export type ConnectionState = 'connecting' | 'pairing' | 'ready' | 'closed' | 'error';

// A request whose response never arrives (a hung desktop handler, a dropped frame, a
// relay wedged mid-stream) would otherwise leave its promise pending forever — and any
// `busy`/`loading` guard keyed off it stuck true. Reject after this long instead.
const REQ_TIMEOUT_MS = 20000;

export class Connection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private retry = 0;
  private closedByUser = false;
  // Fire-and-forget sends made while not `ready` are normally dropped. Callers that need
  // one to survive a brief reconnect (a session-control release) opt in via `queue`, and
  // these are flushed in order the next time the socket reaches `ready`.
  private queued: string[] = [];
  state: ConnectionState = 'closed';
  deviceId: string | null = null;
  url: string;

  constructor(
    url: string,
    private auth: { deviceToken?: string; pairToken?: string; deviceName?: string },
    private onDeviceToken?: (token: string) => void,
    private onAuthError?: () => void,
  ) {
    this.url = url;
  }

  connect() {
    this.closedByUser = false;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    const markLive = () => { this.retry = 0; };

    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; } // one bad frame can't wedge the socket
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
          this.flushQueued();
          return;
        case 'auth-ok':
          this.deviceId = msg.deviceId;
          this.retry = 0;
          markLive();
          this.setState('ready');
          this.flushQueued();
          return;
        case 'auth-err':
          this.closedByUser = true; // don't retry a bad credential in a loop
          // The stored token is bad (revoked, or refused as an identity swap) — clear it
          // so the app doesn't reload it and hit auth-err again on every launch.
          this.onAuthError?.();
          this.setState('error');
          ws.close();
          return;
        case 'res': {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
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
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
      this.pending.clear();
      for (const w of this.fwdWaiters.values()) w.reject(new Error('connection closed'));
      this.fwdWaiters.clear();
      if (this.closedByUser) { if (this.state !== 'error') this.setState('closed'); return; }
      this.setState('connecting');
      // Reconnect to the relay with backoff. The relay may be cold-starting (free
      // hosting), so the first few attempts can fail before it answers.
      const delay = Math.min(1000 * 2 ** this.retry++, 15000);
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
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${ch}`));
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  private fwdWaiters = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>();

  // Forward desktop localhost:<port> to this phone; resolves to the URL to open
  // in its browser. `path` ('/admin') is the page to land on — the whole site is
  // forwarded either way, so from there the browser can walk to any other path.
  forwardPort(port: number, path?: string): Promise<string> {
    if (this.state !== 'ready' || !this.ws) return Promise.reject(new Error('not connected'));
    this.ws.send(JSON.stringify({ t: 'fwd-open', port, path }));
    return new Promise((resolve, reject) => this.fwdWaiters.set(port, { resolve, reject }));
  }

  closeForward(port: number) {
    if (this.state === 'ready' && this.ws) this.ws.send(JSON.stringify({ t: 'fwd-close', port }));
  }

  send(ch: string, args?: unknown, opts?: { queue?: boolean }) {
    const frame = JSON.stringify({ t: 'send', ch, args });
    if (this.state === 'ready' && this.ws) { this.ws.send(frame); return; }
    // Not ready: drop it unless the caller asked us to hold it across the reconnect.
    if (opts?.queue) this.queued.push(frame);
  }

  private flushQueued() {
    if (!this.queued.length || !this.ws) return;
    const frames = this.queued;
    this.queued = [];
    for (const frame of frames) this.ws.send(frame);
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
