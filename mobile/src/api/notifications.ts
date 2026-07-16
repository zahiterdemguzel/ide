// Session alerts — the things that happened while you weren't looking at the phone.
//
// Alerts are derived on the phone from what the connection already pushes: a session
// flipping to `needs-input` or `interrupted` (the `status` push), and the 5-hour
// usage window filling past its thresholds (the same `get-usage` the header ring
// polls). Nothing routine lands here — a run finishing or a push landing is already
// visible on the sessions list, and good news would drown the things that actually
// need a person.
//
// The desktop protocol has no alert log of its own yet; when it grows one
// (`query-notifications`/`notifications-changed`), AlertFeed is the only piece that
// should need replacing.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useConnection } from './context';
import { color } from '../theme';
import type { UsageView } from './usage';

export type AlertKind =
  | 'input'      // a session stopped and is waiting on you
  | 'error'      // a session was interrupted — the run died or was cut short
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

// How each kind looks and reads — one colour per kind, matching what that colour
// already means elsewhere in the app (green = wants you, red = broken, yellow =
// running low). A new alert type is one entry, not a new branch in the renderer.
export const ALERT_STYLE: Record<AlertKind, { icon: any; hue: string }> = {
  input: { icon: 'chatbubble-ellipses', hue: color.green },
  error: { icon: 'alert-circle', hue: color.red },
  usage: { icon: 'hourglass-outline', hue: color.yellow },
};

const MIN = 60000;
const HOUR = 60 * MIN;
const CAP = 50;

// A store rather than screen state: the bell in every header shows the unread count,
// so it and the list have to be reading the same thing.
let alerts: Alert[] = [];
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

// One alert per (kind, id): a session that flips to needs-input twice is one entry
// bumped to now, not a growing pile of duplicates.
function pushAlert(a: Omit<Alert, 'unread' | 'at'> & { at?: number }) {
  alerts = [
    { unread: true, at: Date.now(), ...a },
    ...alerts.filter((x) => x.id !== a.id),
  ].slice(0, CAP);
  emit();
}

// A "needs you" alert is only true while the session is still waiting: the moment it
// moves on (answered from the desktop, resumed, archived), the alert is stale and
// keeping it would send taps to a session that no longer wants anything.
function dropAlert(id: string) {
  const next = alerts.filter((a) => a.id !== id);
  if (next.length === alerts.length) return;
  alerts = next;
  emit();
}

const USAGE_POLL_MS = 60000;
const USAGE_THRESHOLD = 0.75;

// Watches the connection and turns its pushes into alerts. Mounted once at the app
// root (inside the provider) so alerts accumulate no matter which screen is open.
export function AlertFeed(): null {
  const { conn, state } = useConnection();
  // Last seen state per session, so only *transitions* alert — the status push
  // repeats current state on reconnect, and re-alerting then would cry wolf.
  const seen = useRef(new Map<string, string>());
  // Session names as they stream past, so an alert can say which session it is.
  const names = useRef(new Map<string, string>());
  // The usage window we already alerted for, keyed by when it resets — one alert per
  // window, not one per poll above the threshold.
  const warnedWindow = useRef<number | null>(null);

  useEffect(() => {
    if (!conn || state !== 'ready') return;

    const label = (id: string) => names.current.get(id) ?? 'A session';

    const offs = [
      conn.on('session-name', ({ id, name }: any) => {
        if (id && name) names.current.set(id, name);
      }),
      conn.on('status', ({ id, state: next }: any) => {
        if (!id || !next) return;
        const prev = seen.current.get(id);
        seen.current.set(id, next);
        if (prev === next) return;
        if (next === 'needs-input') {
          pushAlert({
            id: `input:${id}`,
            kind: 'input',
            title: 'Session needs your input',
            detail: `“${label(id)}” stopped and is waiting for an answer`,
            sessionId: id,
          });
        } else {
          dropAlert(`input:${id}`);
        }
        if (next === 'interrupted') {
          pushAlert({
            id: `error:${id}`,
            kind: 'error',
            title: 'Session was interrupted',
            detail: `“${label(id)}” stopped before finishing · tap to see where it left off`,
            sessionId: id,
          });
        }
      }),
    ];

    let dropped = false;
    const checkUsage = async () => {
      const usage = await conn.req<UsageView>('get-usage').catch(() => null);
      if (dropped) return;
      const win = usage?.windows?.find((w) => w.key === '5h') ?? usage?.windows?.[0];
      if (!win) return;
      if (win.utilization < USAGE_THRESHOLD) {
        // Below the line again (window rolled over): arm the next warning.
        if (warnedWindow.current !== null && win.resetAt !== warnedWindow.current) warnedWindow.current = null;
        return;
      }
      const key = win.resetAt ?? 0;
      if (warnedWindow.current === key) return;
      warnedWindow.current = key;
      pushAlert({
        id: `usage:${key}`,
        kind: 'usage',
        title: 'Approaching usage limit',
        detail: `${Math.round(win.utilization * 100)}% of your 5-hour window used · resets in ${win.resetIn}`,
        sessionId: null,
      });
    };
    checkUsage();
    const timer = setInterval(checkUsage, USAGE_POLL_MS);

    return () => {
      dropped = true;
      clearInterval(timer);
      offs.forEach((off) => off?.());
    };
  }, [conn, state]);

  return null;
}

// Alerts split by how recent they are, in the design's two buckets. An alert older
// than today falls into a third rather than being dropped — an interrupted session
// from yesterday is still worth seeing.
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
