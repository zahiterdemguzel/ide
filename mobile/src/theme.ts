// The app's design tokens. The screens were written one at a time and each spelled
// its palette out in hex, so the same grey meant three different things; the chat is
// the first screen with enough surfaces to need them named. New UI should pull from
// here, and old screens should migrate when they're next touched.
//
// The palette is the desktop IDE's (GitHub-dark), so the phone and the machine it
// drives look like one product.

import { Platform } from 'react-native';

export const color = {
  bg: '#0d1117',          // the page
  surface: '#161b22',     // headers, bars, the composer
  raised: '#21262d',      // cards, buttons, the user's own messages
  raisedHi: '#30363d',    // a raised surface being pressed
  border: '#30363d',
  borderSoft: '#21262d',

  text: '#e6edf3',
  muted: '#7d8590',
  faint: '#6e7681',

  accent: '#4da3ff',      // the app's blue: links, focus, the send button
  accentDim: '#1f6feb',
  green: '#3fb950',
  greenDeep: '#238636',
  red: '#f85149',
  redSoft: '#ffa198',
  yellow: '#d29922',
  purple: '#a371f7',
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

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const font = {
  // RN takes a font *name*, not a stack, and an unknown one silently falls back to
  // the system sans — which would render code as prose. So each platform gets the
  // name it actually ships.
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  size: { xs: 11, sm: 13, md: 15, lg: 17 },
} as const;
