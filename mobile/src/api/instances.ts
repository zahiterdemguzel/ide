// The desktop windows a phone can drive. Pairing is with the *machine* — one QR, one
// device token, one room — but the IDE runs many instances side by side and each has
// its own sessions, its own open project and its own terminals. So after connecting,
// the phone asks for the roster (`list-instances`, authed) and picks one.
//
// The roster is not persisted: an instance id is minted per process, so yesterday's
// choice names a window that no longer exists. Every launch lists afresh.

import type { Endpoints } from './pairing';

export type Instance = {
  id: string;
  startedAt: number;
  project: string | null;
  // true for the window that served this very request — the one the bootstrap dial
  // happened to land on, so choosing it needs no reconnect.
  current: boolean;
};

// Where to reach one particular window, derived from the relay endpoint pairing
// gave us: every window shares the machine's room and is told apart inside it by
// instance id.
export function instanceEndpoints(bootstrap: Endpoints, inst: Instance): Endpoints {
  const out: Endpoints = {};
  if (bootstrap.relay) out.relay = `${bootstrap.relay}&instance=${encodeURIComponent(inst.id)}`;
  return out;
}

// "5m", "3h", "2d" — how long this window has been open. What the list is sorted by,
// so it is also what tells two windows on the same project apart.
export function uptime(startedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - startedAt) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
