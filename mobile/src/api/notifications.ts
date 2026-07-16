// Session alerts — the things that happened while you weren't looking at the phone.
//
// TODO: THIS IS MOCK DATA. Nothing in the desktop protocol pushes alerts yet; the
// events they'd be built from already exist (`status` carries error states,
// session-commit reports rejected pushes, `get-usage` knows the 5h window), but
// nothing records them as a list with a read/unread state. Wiring this up means a
// main-side log — an alert per transition, capped and persisted like sessions are —
// plus a `query-notifications`/`notifications-changed` pair to page and push it.
// Until then the screen renders this fixture so the UI can be reviewed.
//
// The types and the store below are the real shape, so replacing `SEED` with a
// protocol read is the only change the screen should need.

import { useSyncExternalStore } from 'react';
import { color } from '../theme';

// Only things that need attention are alerts: something went wrong, or the usage
// window is filling. Routine good news (a run finishing, a push landing) is visible
// on the sessions list already and would drown the errors here.
export type AlertKind =
  | 'error'      // something failed — a rejected push, a run that died, a tool error
  | 'usage';     // the 5h window is filling up

export type Alert = {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  at: number;              // ms epoch
  unread: boolean;
  sessionId: string | null; // where tapping it goes; null for alerts with no session
};

// How each kind looks and reads. Keeping the icon and hue here rather than in the
// screen means a new alert type is one entry, not a new branch in the renderer.
export const ALERT_STYLE: Record<AlertKind, { icon: any; hue: string }> = {
  error: { icon: 'alert-circle', hue: color.red },
  usage: { icon: 'hourglass-outline', hue: color.yellow },
};

const MIN = 60000;
const HOUR = 60 * MIN;

const now = Date.now();
const SEED: Alert[] = [
  {
    id: 'a1',
    kind: 'error',
    title: 'Session hit an error',
    detail: '“Refactor git-pane sections” · npm test failed and the run stopped',
    at: now - MIN,
    unread: true,
    sessionId: null,
  },
  {
    id: 'a2',
    kind: 'error',
    title: 'Push was rejected',
    detail: "Remote has commits this branch doesn't · tap to let Claude resolve",
    at: now - 4 * HOUR,
    unread: false,
    sessionId: null,
  },
  {
    id: 'a3',
    kind: 'usage',
    title: 'Approaching usage limit',
    detail: '78% of your 5-hour window used',
    at: now - 5 * HOUR,
    unread: false,
    sessionId: null,
  },
];

// A store rather than screen state: the bell in every header shows the unread count,
// so it and the list have to be reading the same thing.
let alerts: Alert[] = SEED;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useAlerts(): Alert[] {
  return useSyncExternalStore(subscribe, () => alerts);
}

export function useUnreadCount(): number {
  return useSyncExternalStore(subscribe, () => alerts.filter((a) => a.unread).length);
}

export function markAllRead() {
  if (!alerts.some((a) => a.unread)) return;
  alerts = alerts.map((a) => (a.unread ? { ...a, unread: false } : a));
  emit();
}

export function markRead(id: string) {
  const hit = alerts.find((a) => a.id === id);
  if (!hit || !hit.unread) return;
  alerts = alerts.map((a) => (a.id === id ? { ...a, unread: false } : a));
  emit();
}

// Alerts split by how recent they are, in the design's two buckets. An alert older
// than today falls into a third rather than being dropped — a rejected push from
// yesterday is still worth seeing.
export function groupAlerts(list: Alert[], at: number = Date.now()) {
  const midnight = new Date(at).setHours(0, 0, 0, 0);
  const buckets: { key: string; label: string; data: Alert[] }[] = [
    { key: 'now', label: 'Just now', data: [] },
    { key: 'today', label: 'Earlier today', data: [] },
    { key: 'older', label: 'Older', data: [] },
  ];
  for (const a of [...list].sort((x, y) => y.at - x.at)) {
    const bucket = at - a.at < HOUR ? 0 : a.at >= midnight ? 1 : 2;
    buckets[bucket].data.push(a);
  }
  return buckets.filter((b) => b.data.length > 0);
}
