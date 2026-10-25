// Desktop side of the direct phone ↔ desktop link. The relay is only the
// introducer: an authed phone sends its WebRTC offer over its relay socket, we
// answer over the same socket, ICE candidates trickle both ways, and once the data
// channel opens it becomes an ordinary hub client — hello → auth → ready, exactly
// like a relay socket — after which the phone closes its relay socket and nothing
// it does crosses the relay again. A phone whose network can't be hole-punched
// never gets a channel and just stays on the relay.
//
// The WebRTC implementation (node-datachannel's PeerConnection) is injected, so this
// file stays Electron-free and testable with a fake.

const proto = require('./protocol');
const { ICE_SERVERS, splitFrame, createFrameAssembler } = require('./p2p-lib');
const { debugFor } = require('./debug');

const debug = debugFor('p2p');

// A negotiation that hasn't produced an open channel by now won't: the phone gives
// up sooner (see mobile p2p.ts) and stays on the relay, so free what we hold.
const NEGOTIATE_TIMEOUT_MS = 20000;

// opts: { hub, PeerConnection, iceServers?, negotiateTimeoutMs? }
// Returns the hub's `p2p` hook: { signal(clientNo, msg, reply), release(clientNo), closeAll(), linkCount() }.
function createP2pHost({ hub, PeerConnection, iceServers = ICE_SERVERS, negotiateTimeoutMs = NEGOTIATE_TIMEOUT_MS }) {
  const negotiating = new Map(); // signaling client no -> peer still being set up
  const links = new Set(); // peers whose data channel is open

  function teardown(peer, reason) {
    if (peer.done) return;
    peer.done = true;
    clearTimeout(peer.timer);
    if (negotiating.get(peer.signalNo) === peer) negotiating.delete(peer.signalNo);
    links.delete(peer);
    debug('teardown', { client: peer.signalNo, reason, links: links.size });
    if (peer.hubClient) peer.hubClient.close();
    try { peer.channel?.close(); } catch { /* already closed */ }
    try { peer.pc.close(); } catch { /* already closed */ }
  }

  function sendFrame(peer, frame) {
    for (const part of splitFrame(JSON.stringify(frame))) peer.channel.sendMessage(part);
  }

  function openLink(peer) {
    if (peer.done || peer.hubClient) return;
    clearTimeout(peer.timer);
    negotiating.delete(peer.signalNo);
    links.add(peer);
    debug('link open', { client: peer.signalNo, links: links.size });
    peer.hubClient = hub.connect((frame) => { if (!peer.done) sendFrame(peer, frame); });
    const assemble = createFrameAssembler((text) => peer.hubClient.handle(text));
    peer.channel.onMessage((message) => assemble(typeof message === 'string' ? message : Buffer.from(message).toString()));
  }

  function attachChannel(peer, channel) {
    if (peer.channel) { try { channel.close(); } catch {} return; } // one channel per peer
    peer.channel = channel;
    channel.onClosed(() => teardown(peer, 'channel-closed'));
    channel.onError((err) => debug('channel error', { client: peer.signalNo, error: String(err) }));
    if (channel.isOpen()) openLink(peer); else channel.onOpen(() => openLink(peer));
  }

  function acceptOffer(signalNo, sdp, reply) {
    const previous = negotiating.get(signalNo);
    if (previous) teardown(previous, 'superseded');
    const pc = new PeerConnection(`ide-phone-${signalNo}`, { iceServers });
    const peer = { signalNo, pc, channel: null, hubClient: null, done: false, timer: null };
    negotiating.set(signalNo, peer);
    peer.timer = setTimeout(() => teardown(peer, 'negotiate-timeout'), negotiateTimeoutMs);
    peer.timer.unref?.();

    pc.onLocalDescription((localSdp) => reply(proto.rtcAnswer(localSdp)));
    pc.onLocalCandidate((candidate, mid) => reply(proto.rtcIce(candidate, mid)));
    pc.onDataChannel((channel) => attachChannel(peer, channel));
    pc.onStateChange((state) => {
      debug('state', { client: signalNo, state });
      if (state === 'failed' || state === 'closed') teardown(peer, state);
    });
    pc.setRemoteDescription(sdp, 'offer');
    debug('offer accepted', { client: signalNo });
  }

  function signal(signalNo, msg, reply) {
    try {
      if (msg.t === 'rtc-offer') return acceptOffer(signalNo, msg.sdp, reply);
      if (msg.t === 'rtc-ice' && msg.candidate) negotiating.get(signalNo)?.pc.addRemoteCandidate(msg.candidate, msg.mid);
    } catch (err) {
      // A malformed SDP or candidate from the network is expected input, not a crash.
      debug('signal failed', { client: signalNo, t: msg.t, error: String((err && err.message) || err) });
      const peer = negotiating.get(signalNo);
      if (peer) teardown(peer, 'signal-error');
      reply(proto.rtcUnavailable());
    }
  }

  return {
    signal,
    // The signaling socket went away. A link that already opened no longer needs it.
    release(signalNo) {
      const peer = negotiating.get(signalNo);
      if (peer) teardown(peer, 'signaling-closed');
    },
    closeAll() {
      for (const peer of [...negotiating.values(), ...links]) teardown(peer, 'host-closed');
    },
    linkCount: () => links.size,
  };
}

module.exports = { createP2pHost, NEGOTIATE_TIMEOUT_MS };
