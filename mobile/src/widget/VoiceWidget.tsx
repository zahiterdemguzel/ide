// The home-screen widget: one record button that starts a new session from speech.
// Tapping anywhere on it opens the app's listening sheet through the voice deep link;
// tapping again while it says "Listening" sends what was heard. Android widgets get
// clicks only (no press/release), so the hold gesture lives in the app's New session
// button instead.
//
// Drawn with react-native-android-widget's primitives, which map to RemoteViews — no
// shadows or animation — so the look comes from the app's own tokens: the surface
// card, its border, and the accent blue (red while listening) on the button.
import React from 'react';
import { FlexWidget, SvgWidget, TextWidget } from 'react-native-android-widget';
import { color } from '../theme';
import { VOICE_LINK } from '../lib/voice-capture';

export const VOICE_WIDGET_NAME = 'VoiceSession';

// Below this width (dp) there is room for the button only.
const COMPACT_WIDTH = 150;

const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>`;
const STOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="3" fill="#ffffff"/></svg>`;

const OPEN_VOICE = { clickAction: 'OPEN_URI', clickActionData: { uri: VOICE_LINK } } as const;

function RecordButton({ listening, size }: { listening: boolean; size: number }) {
  return (
    <FlexWidget
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundGradient: listening
          ? { from: color.red, to: '#b62324', orientation: 'TL_BR' }
          : { from: color.accent, to: color.accentDim, orientation: 'TL_BR' },
      }}
      {...OPEN_VOICE}
    >
      <SvgWidget svg={listening ? STOP_SVG : MIC_SVG} style={{ width: size * 0.46, height: size * 0.46 }} />
    </FlexWidget>
  );
}

export function VoiceWidget({ listening = false, width = 250 }: { listening?: boolean; width?: number }) {
  const compact = width < COMPACT_WIDTH;
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: compact ? 'center' : 'flex-start',
        paddingHorizontal: compact ? 0 : 12,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: listening ? '#5c2326' : color.border,
        backgroundGradient: { from: color.surface, to: color.surfaceDeep, orientation: 'TOP_BOTTOM' },
      }}
      {...OPEN_VOICE}
    >
      <RecordButton listening={listening} size={compact ? 52 : 48} />
      {!compact && (
        <FlexWidget style={{ flex: 1, flexDirection: 'column', marginLeft: 12 }} {...OPEN_VOICE}>
          <TextWidget
            text={listening ? 'Listening…' : 'New session'}
            maxLines={1}
            truncate="END"
            style={{ fontSize: 16, fontWeight: '600', color: listening ? color.redSoft : color.text }}
          />
          <TextWidget
            text={listening ? 'Tap again to send' : 'Tap to speak a task'}
            maxLines={1}
            truncate="END"
            style={{ fontSize: 12, color: color.muted, marginTop: 2 }}
          />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}
