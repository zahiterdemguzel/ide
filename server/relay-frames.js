// The relay's entire vocabulary, on the one socket it holds to a desktop. Two
// multiplexes share that socket and are told apart by which key is present:
//
//   { c: <clientId>, joined: true } relay → desktop: a phone's socket is up.
//   { c: <clientId>, d: <frame> }   a mobile client's IDE frame, both ways.
//                                   `d` is opaque — the relay never looks inside.
//   { c: <clientId>, gone: true }   relay → desktop: that client's socket died.
//   { h: <streamId>, t: … }         a byte stream for a forwarded dev server.
//
// `joined` exists because the desktop speaks first: the hello → pair/auth → ready
// machine opens with a `hello` and the phone says nothing until it has one. With
// only `d` frames to go on, the desktop would wait for a frame the phone will
// never send. It doubles as the desktop's re-attach signal — a desktop that
// reconnects to a room gets a `joined` for every phone already in it, sends each
// a fresh hello, and they re-auth over the sockets they already hold.
//
// The `h` stream is deliberately dumb: raw TCP bytes, base64'd, in order. The
// relay does not speak HTTP to the desktop and the desktop does not speak HTTP
// back — the desktop just pipes the bytes into its own http-proxy listener, so
// auth, the cookie swap and the HMR upgrade keep working untouched.

const clientFrame = (c, d) => ({ c, d });
const clientJoined = (c) => ({ c, joined: true });
const clientGone = (c) => ({ c, gone: true });

// relay → desktop: start a stream to the dev server forwarded on `port`.
const tunnelOpen = (h, port) => ({ h, t: 'open', port });
// both ways: bytes.
const tunnelData = (h, buf) => ({ h, t: 'data', b: Buffer.from(buf).toString('base64') });
// both ways: this side is done writing / the stream is dead.
const tunnelEnd = (h) => ({ h, t: 'end' });
const tunnelClose = (h, error) => (error ? { h, t: 'close', error } : { h, t: 'close' });

const tunnelBytes = (msg) => Buffer.from(String(msg.b || ''), 'base64');

const isClientFrame = (msg) => !!msg && typeof msg === 'object' && msg.c !== undefined;
const isTunnelFrame = (msg) => !!msg && typeof msg === 'object' && msg.h !== undefined;

module.exports = {
  clientFrame, clientJoined, clientGone,
  tunnelOpen, tunnelData, tunnelEnd, tunnelClose, tunnelBytes,
  isClientFrame, isTunnelFrame,
};
