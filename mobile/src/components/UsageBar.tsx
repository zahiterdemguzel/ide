// Remaining Claude subscription usage, as a hairline under the header.
//
// The desktop's toolbar meter (src/renderer/usage-meter.js) shows both rolling
// windows with labels and a countdown; a phone header has room for none of that,
// so this is the 5-hour window alone — the one users actually hit — drawn as a
// bare line that fills and reddens as it approaches the limit. No text: the bar
// is ambient, and a number here would compete with the project name above it.
//
// Same data (`get-usage`, null whenever there's no OAuth token), same 30s poll.
import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useConnection } from '../api/context';
import { color } from '../theme';

const POLL_MS = 30000;

type UsageWindow = { key: string; utilization: number };
type Usage = { windows: UsageWindow[] } | null;

// Green until half spent, then through yellow into red at the limit — the same
// three colours the desktop meter steps through, interpolated instead of stepped
// so the bar reddens gradually rather than snapping at a threshold.
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [63, 185, 80]],    // color.green
  [0.5, [210, 153, 34]], // color.yellow
  [1, [248, 81, 73]],    // color.red
];

function rampColor(util: number): string {
  for (let i = 1; i < STOPS.length; i++) {
    const [hi, cHi] = STOPS[i];
    if (util > hi && i < STOPS.length - 1) continue;
    const [lo, cLo] = STOPS[i - 1];
    const t = hi === lo ? 0 : Math.min(1, Math.max(0, (util - lo) / (hi - lo)));
    const [r, g, b] = cLo.map((c, j) => Math.round(c + (cHi[j] - c) * t));
    return `rgb(${r}, ${g}, ${b})`;
  }
  return color.green;
}

export default function UsageBar() {
  const { conn, state } = useConnection();
  const [util, setUtil] = useState<number | null>(null);

  useEffect(() => {
    if (!conn || state !== 'ready') return;
    let dropped = false;
    const refresh = async () => {
      const usage = await conn.req<Usage>('get-usage').catch(() => null);
      if (dropped) return;
      const win = usage?.windows?.find((w) => w.key === '5h');
      setUtil(win ? Math.min(1, Math.max(0, win.utilization)) : null);
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { dropped = true; clearInterval(timer); };
  }, [conn, state]);

  // Nothing to say (no OAuth token, an API-key user, a transient failure) → no line.
  if (util === null) return null;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${util * 100}%`, backgroundColor: rampColor(util) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: color.borderSoft,
  },
  fill: { height: '100%' },
});
