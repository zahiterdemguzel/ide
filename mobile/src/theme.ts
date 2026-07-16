// The app's design tokens. The screens were written one at a time and each spelled
// its palette out in hex, so the same grey meant three different things; the chat is
// the first screen with enough surfaces to need them named. New UI should pull from
// here, and old screens should migrate when they're next touched.
//
// The palette is the desktop IDE's (GitHub-dark), so the phone and the machine it
// drives look like one product.

import { Platform, StatusBar, type TextStyle } from 'react-native';

export const color = {
  bg: '#0d1117',          // the page, and the recessed well a segmented control sits in
  surface: '#161b22',     // headers, bars, cards, the composer
  surfaceDeep: '#12161d', // the header gradient's far end; also punches the usage ring's hole
  raised: '#21262d',      // pills, chips, buttons, the user's own messages
  raisedHi: '#30363d',    // a raised surface being pressed, and the active segment
  border: '#30363d',
  borderSoft: '#21262d',

  text: '#e6edf3',
  body: '#c9d1d9',        // file names and code — a shade below `text` so paths recede
  muted: '#7d8590',
  faint: '#6e7681',
  iconFaint: '#484f58',   // chevrons and other furniture

  accent: '#4da3ff',      // the app's blue: links, focus, the send button
  accentDim: '#1f6feb',
  green: '#3fb950',
  greenSoft: '#7ee787',   // added diff lines — the soft twin of `green`, as `redSoft` is to `red`
  greenDeep: '#238636',
  red: '#f85149',
  redSoft: '#ffa198',
  yellow: '#d29922',
  purple: '#a371f7',

  // The editor's syntax hues, borrowed for file-type icons and git status badges so
  // a file reads the same colour here as it does on the desktop.
  fileYellow: '#e5c07b',
  fileGreen: '#98c379',
  fileRed: '#e06c75',
} as const;

// The status dot the desktop shows beside a session, in the desktop's colours.
export const stateColor: Record<string, string> = {
  idle: color.faint,
  working: color.yellow,
  'needs-input': color.green,
  completed: color.green,
  interrupted: color.red,
  pushed: color.purple,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

// `card` is the system's signature radius — cards, and only cards, are 14.
export const radius = { sm: 6, md: 10, card: 14, lg: 16, pill: 999 } as const;

// Screen chrome insets — deliberately just a floor, not a measurement.
//
// There is no `statusBar` or `homeIndicator` constant here, and there must not be.
// The design mocks an iPhone, where the notch is 54 and the gesture bar 40; both
// numbers are wrong on Android (its status bar is roughly half a notch, and its
// navigation bar isn't part of our window at all while we're not edge-to-edge — see
// `androidNavigationBar` in app.json). Hardcoding either reserves space the device
// doesn't have or the system already owns: one frame comes out over-tall, the other
// leaves a dead strip above the system's own bar. Both were real bugs.
//
// So every frame measures with `useSafeAreaInsets()` and clamps the top with
// `Math.max(insets.top, inset.minTop)` — the floor is only for a device that reports
// no inset at all, which would otherwise crowd the top row against the edge.
export const inset = { minTop: 12 } as const;

// Every scrim Modal sets `statusBarTranslucent`, so its dim covers the status bar
// instead of stopping short of it (Android otherwise gives the modal a window that
// starts below the bar — an undimmed strip across the top). The prop moves the
// modal's origin to the top of the *screen*, but the app's own window still starts
// below the status bar while we're not edge-to-edge — so anything positioned from a
// measurement taken in the app window (`measureInWindow`, `useSafeAreaInsets`) must
// add this shift back to line up. Measured, not a constant; 0 on iOS, whose modals
// already share the app window's origin. See mobile-design.md, "Darkening the screen".
export const MODAL_TOP_SHIFT = Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0;

// The tab bar's own height, before the device's gesture inset is added under it.
// Here rather than in App.tsx because a full-screen Modal covers the tab bar, so
// anything anchored above the bar (the Sessions model menu) has to know how tall it
// is — and importing that from App.tsx would be a cycle.
export const TAB_BAR_HEIGHT = 56;

export const font = {
  // RN takes a font *name*, not a stack, and an unknown one silently falls back to
  // the system sans — which would render code as prose. So each platform gets the
  // name it actually ships.
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  size: { xs: 11, sm: 13, md: 15, lg: 17 },
} as const;

// The recurring text roles. Screens should reach for these before spelling out a
// size/weight pair, so a "category label" means one thing everywhere.
// Not `as const`: RN's TextStyle wants mutable arrays (fontVariant), so the literal
// widening a plain annotation gives is exactly right here.
export const type: Record<
  'largeTitle' | 'cardTitle' | 'category' | 'fieldLabel' | 'meta' | 'time',
  TextStyle
> = {
  largeTitle: { fontSize: 28, fontWeight: '700', letterSpacing: 0.2, color: color.text },
  cardTitle: { fontSize: 16, fontWeight: '600', lineHeight: 21, color: color.text },
  // NEEDS YOU / WORKING / SETTLED / STAGED / CHANGES / FORWARDING. The hue is the
  // caller's — it's what distinguishes one category from the next.
  category: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  fieldLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 0.5, color: color.faint },
  meta: { fontSize: 12, color: color.muted },
  time: { fontSize: 13, color: color.faint, fontVariant: ['tabular-nums'] },
};

// The animations the system uses: the working dot's spinner, the lap a working card's
// hue makes around its own edge, and the wash over a run that just landed.
export const motion = { spin: 700, orbit: 2400, flash: 1200 } as const;

// Elevation, lightest to heaviest. RN needs both the iOS shadow set and Android's
// single `elevation`, so each level ships both.
export const shadow = {
  thumb: { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  button: { shadowColor: color.greenDeep, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  menu: { shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 32, shadowOffset: { width: 0, height: 12 }, elevation: 16 },
} as const;

// A hue at partial alpha. The system's tinted things — status badges, count pills,
// the glow on a card that needs you — are all one hue at three strengths: a wash
// for the fill, a stronger line for the border, the solid hue for the text. Keeping
// that as a function rather than a table means a new hue needs no new tokens.
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// The strengths that formula is used at, named so a badge can't drift from a pill.
export const tint = {
  fill: (hex: string) => alpha(hex, 0.12),
  fillStrong: (hex: string) => alpha(hex, 0.15),
  line: (hex: string) => alpha(hex, 0.35),
  glow: (hex: string) => alpha(hex, 0.07),
  glowLine: (hex: string) => alpha(hex, 0.45),
  // The desktop's finish flash, `color-mix(in srgb, var(--green) 34%, transparent)`.
  flash: (hex: string) => alpha(hex, 0.34),
} as const;
