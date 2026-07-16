// Claude subscription usage: the ring in every screen's header, and the panel that
// ring opens.
//
// The desktop's toolbar meter (src/renderer/usage-meter.js) shows both rolling
// windows with labels and a countdown side by side; a phone header has room for
// none of that, so the header is the 5-hour window's ring alone — the window users
// actually hit — and tapping it opens UsagePanel with everything the desktop shows.
//
// Same data (`get-usage`, null whenever there's no OAuth token), same 30s poll.
import { useEffect, useState } from 'react';
import { useConnection } from './context';
import { color } from '../theme';

const POLL_MS = 30000;

// The shape src/main/usage-parse.js's usageView() returns, per rolling window.
export type UsageWindow = {
  key: string;
  utilization: number;
  resetIn: string;
  resetAt: number | null;
  representative: boolean;
};
export type UsageView = { windows: UsageWindow[] } | null;

// Green until half spent, then through yellow into red at the limit — the same
// three colours the desktop meter steps through, interpolated instead of stepped so
// the ring reddens gradually rather than snapping at a threshold.
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [63, 185, 80]],    // color.green
  [0.5, [210, 153, 34]], // color.yellow
  [1, [248, 81, 73]],    // color.red
];

function rampRgb(util: number): [number, number, number] | null {
  for (let i = 1; i < STOPS.length; i++) {
    const [hi, cHi] = STOPS[i];
    if (util > hi && i < STOPS.length - 1) continue;
    const [lo, cLo] = STOPS[i - 1];
    const t = hi === lo ? 0 : Math.min(1, Math.max(0, (util - lo) / (hi - lo)));
    return cLo.map((c, j) => Math.round(c + (cHi[j] - c) * t)) as [number, number, number];
  }
  return null;
}

export function rampColor(util: number): string {
  const rgb = rampRgb(util);
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : color.green;
}

// The ramp at partial alpha — theme.ts's `tint` can't be used on it, since `alpha()`
// parses hex and the ramp is a blend between stops.
export function rampTint(util: number, a: number): string {
  const rgb = rampRgb(util) ?? [63, 185, 80];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

// Both windows, or null when there's nothing to say (no OAuth token, an API-key
// user, a transient failure) — the header then draws no ring at all.
export function useUsage(): UsageView {
  const { conn, state } = useConnection();
  const [view, setView] = useState<UsageView>(null);

  useEffect(() => {
    if (!conn || state !== 'ready') return;
    let dropped = false;
    const refresh = async () => {
      const usage = await conn.req<UsageView>('get-usage').catch(() => null);
      if (dropped) return;
      setView(usage?.windows?.length ? usage : null);
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { dropped = true; clearInterval(timer); };
  }, [conn, state]);

  return view;
}

export function windowUtil(view: UsageView, key: string): number | null {
  const win = view?.windows?.find((w) => w.key === key);
  return win ? Math.min(1, Math.max(0, win.utilization)) : null;
}

// How long until a window rolls over, as main already formatted it ("24m", "13h",
// "2d", "now"). Deliberately not recomputed here from `resetAt`: main's
// formatResetShort is what the desktop meter reads too, so taking the string keeps
// the two saying the same thing, and the value only moves at minute granularity —
// which the 30s poll already tracks closely enough to not need a ticking clock.
export function windowResetIn(view: UsageView, key: string): string {
  return view?.windows?.find((w) => w.key === key)?.resetIn ?? '';
}
