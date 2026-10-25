// Pure pieces of the direct (peer-to-peer) phone ↔ desktop link. The relay only
// introduces the two ends: the phone sends a WebRTC offer over its authed relay
// socket, the desktop answers, ICE candidates cross the same way — and from then on
// the hub protocol runs over a data channel that never touches the relay.
// mobile/src/api/p2p.ts mirrors ICE_SERVERS and the chunk format; keep them in step.

// Public STUN only: they tell each end its own public address so NAT hole-punching
// can work. When it can't (symmetric/carrier-grade NAT), the phone simply stays on
// the relay — that is the fallback, so no TURN server is needed.
const ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

// SCTP implementations disagree on the largest message they accept (libwebrtc on
// the phone, libdatachannel here); 64KB is safely under all of them. Hub frames are
// often far larger (a 12MB read-asset-chunk, a screen JPEG), so they are split.
const CHUNK_CHARS = 64 * 1024;

// Message prefixes on the data channel. A whole frame is plain JSON and so always
// starts with '{'. A split frame is sent as '+'-prefixed parts followed by one
// '.'-prefixed final part; the channel is ordered and a frame's parts are sent
// back-to-back, so parts of two frames never interleave.
const PART = '+';
const LAST_PART = '.';

function splitFrame(text, chunkChars = CHUNK_CHARS) {
  if (text.length <= chunkChars) return [text];
  const parts = [];
  for (let at = 0; at < text.length; at += chunkChars) {
    const isLast = at + chunkChars >= text.length;
    parts.push((isLast ? LAST_PART : PART) + text.slice(at, at + chunkChars));
  }
  return parts;
}

// Feed it every data-channel message; it calls onFrame with each complete frame.
function createFrameAssembler(onFrame) {
  let pending = [];
  return (message) => {
    const head = message[0];
    if (head === PART) { pending.push(message.slice(1)); return; }
    if (head === LAST_PART) {
      pending.push(message.slice(1));
      const frame = pending.join('');
      pending = [];
      onFrame(frame);
      return;
    }
    pending = []; // a whole frame can't follow unfinished parts; drop the fragment
    onFrame(message);
  };
}

module.exports = { ICE_SERVERS, CHUNK_CHARS, splitFrame, createFrameAssembler };
