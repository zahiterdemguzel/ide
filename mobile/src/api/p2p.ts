// The direct phone ↔ desktop link (desktop side: server/p2p-host.js). The relay only
// introduces us: once authed over it, we send a WebRTC offer through it, the desktop
// answers, ICE candidates trickle across, and the data channel that opens carries
// the same hub protocol — so the relay can be closed. When hole-punching can't work
// (carrier-grade NAT, strict corporate Wi-Fi) no channel opens, the attempt times
// out, and the connection simply stays on the relay.
//
// ICE_SERVERS and the chunk format mirror server/p2p-lib.js; keep them in step.

// react-native-webrtc is a native module: Expo Go and older builds don't have it,
// and then every connection stays on the relay as it always did.
let webrtc: any = null;
try { webrtc = require('react-native-webrtc'); } catch { /* relay only */ }

export const directLinksSupported = () => !!webrtc;

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

// Shorter than the desktop's 20s: by then the user has long been on the relay and a
// late success would only switch transports under them for no visible gain.
const DIRECT_TIMEOUT_MS = 12000;

const CHUNK_CHARS = 64 * 1024;
const PART = '+';
const LAST_PART = '.';

export function splitFrame(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += CHUNK_CHARS) {
    const isLast = at + CHUNK_CHARS >= text.length;
    parts.push((isLast ? LAST_PART : PART) + text.slice(at, at + CHUNK_CHARS));
  }
  return parts;
}

function createFrameAssembler(onFrame: (text: string) => void) {
  let pending: string[] = [];
  return (message: string) => {
    const head = message[0];
    if (head === PART) { pending.push(message.slice(1)); return; }
    if (head === LAST_PART) {
      pending.push(message.slice(1));
      const frame = pending.join('');
      pending = [];
      onFrame(frame);
      return;
    }
    pending = [];
    onFrame(message);
  };
}

export type DirectAttempt = {
  // Feed it the relay frames that belong to signaling: rtc-answer / rtc-ice / rtc-unavailable.
  handleSignal(msg: any): void;
  // The open link's sender. Only valid after onOpen.
  send(frame: string): void;
  close(): void;
};

// Starts a direct link. `sendSignal` goes over the relay socket. `onOpen` fires once
// the channel is up (the desktop's hub then greets us with `hello` on it); `onFrame`
// receives every frame from the channel; `onClosed` fires once, whether the attempt
// failed, timed out, or an open link later dropped.
export function startDirectLink(handlers: {
  sendSignal: (msg: object) => void;
  onOpen: () => void;
  onFrame: (text: string) => void;
  onClosed: () => void;
}): DirectAttempt | null {
  if (!webrtc) return null;
  const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = webrtc;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel('ide', { ordered: true });
  let opened = false;
  let done = false;

  const close = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { channel.close(); } catch { /* already closed */ }
    try { pc.close(); } catch { /* already closed */ }
    handlers.onClosed();
  };
  const timer = setTimeout(() => { if (!opened) close(); }, DIRECT_TIMEOUT_MS);

  pc.addEventListener('icecandidate', (e: any) => {
    if (e.candidate) handlers.sendSignal({ t: 'rtc-ice', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' });
  });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close();
  });
  const assemble = createFrameAssembler((text) => { if (!done) handlers.onFrame(text); });
  channel.addEventListener('message', (e: any) => assemble(String(e.data)));
  channel.addEventListener('open', () => {
    opened = true;
    clearTimeout(timer);
    handlers.onOpen();
  });
  channel.addEventListener('close', close);

  (async () => {
    try {
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      handlers.sendSignal({ t: 'rtc-offer', sdp: offer.sdp });
    } catch { close(); }
  })();

  return {
    handleSignal(msg) {
      if (done) return;
      if (msg.t === 'rtc-unavailable') { close(); return; }
      if (msg.t === 'rtc-answer') {
        pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp })).catch(close);
      } else if (msg.t === 'rtc-ice') {
        pc.addIceCandidate(new RTCIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid })).catch(() => { /* one bad candidate isn't fatal */ });
      }
    },
    send(frame) {
      if (done) return;
      for (const part of splitFrame(frame)) channel.send(part);
    },
    close,
  };
}
