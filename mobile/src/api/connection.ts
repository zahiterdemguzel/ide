// WebSocket client for the desktop's remote server (server/ws-server.js).
// The protocol mirrors the desktop's IPC 1:1: req/res with id correlation,
// fire-and-forget sends, and ev pushes. Reconnects with backoff and re-auths
// using the stored device token.

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
  private closedByUser = false;
  state: ConnectionState = 'closed';
  deviceId: string | null = null;

  constructor(
    public url: string,
    private auth: { deviceToken?: string; pairToken?: string; deviceName?: string },
    private onDeviceToken?: (token: string) => void,
  ) {}

  connect() {
    this.closedByUser = false;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

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
          this.setState('ready');
          return;
        case 'auth-ok':
          this.deviceId = msg.deviceId;
          this.retry = 0;
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
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (this.closedByUser) { if (this.state !== 'error') this.setState('closed'); return; }
      this.setState('connecting');
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
