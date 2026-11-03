// Drawing the voice widget: the headless task Android wakes when a widget is added,
// resized or due an update, and the app-side redraw that flips it to "Listening"
// while a capture runs (so the second tap on the home screen reads as "send").
import React from 'react';
import { Platform } from 'react-native';
import { requestWidgetUpdate, type WidgetTaskHandlerProps } from 'react-native-android-widget';
import { VoiceWidget, VOICE_WIDGET_NAME } from './VoiceWidget';

// The headless task always draws the idle state: it runs when the app may not be
// alive, and a widget left saying "Listening" after the app died would lie.
export async function voiceWidgetTaskHandler({ widgetInfo, widgetAction, renderWidget }: WidgetTaskHandlerProps) {
  if (widgetInfo.widgetName !== VOICE_WIDGET_NAME || widgetAction === 'WIDGET_DELETED') return;
  renderWidget(<VoiceWidget width={widgetInfo.width} />);
}

export function refreshVoiceWidget(listening: boolean): void {
  if (Platform.OS !== 'android') return;
  requestWidgetUpdate({
    widgetName: VOICE_WIDGET_NAME,
    renderWidget: (info) => <VoiceWidget listening={listening} width={info.width} />,
  }).catch(() => {
    // A build without the widget module (a dev client from before it was added)
    // has nothing to redraw; the capture itself is unaffected.
  });
}
