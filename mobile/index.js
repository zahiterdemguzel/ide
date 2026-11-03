// The app's entry. Expo's default (expo/AppEntry.js) only registers App; the
// home-screen widget also needs its headless task registered here, before any
// screen mounts, because Android can wake the JS runtime just to draw a widget.
import { Platform } from 'react-native';
import { registerRootComponent } from 'expo';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import App from './App';
import { voiceWidgetTaskHandler } from './src/widget/task-handler';

registerRootComponent(App);
if (Platform.OS === 'android') registerWidgetTaskHandler(voiceWidgetTaskHandler);
