// The listening sheet: speak a task, and a new session starts with it as the first
// prompt. Opened by the home-screen widget (tap to start, tap again — on the widget or
// here — to send) or by holding New session (let go to send).
//
// It is a plain absolutely-positioned View above the navigator, not a <Modal>: a
// Modal is a separate Android window, and opening one under a finger that is holding
// New session cancels that press — the hold would "release" the instant the sheet
// appeared. A View on top leaves the Pressable as the touch responder.
//
// The capture can outrun the connection (a cold start from the widget is still
// dialling the desktop while you talk), so a finished transcript waits for `ready`
// and then creates the session; while it waits the sheet shrinks to a bottom card so
// the window chooser behind it stays usable.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { alpha, color, radius, space, type } from '../theme';
import { useConnection } from '../api/context';
import { getSessionModel } from '../api/models';
import { newSessionWithPrompt } from '../api/session-prompt';
import { getVoiceLang, onVoiceRequest, setVoiceLang, type VoiceSource } from '../api/voice';
import { cliCheckChannel, cliForModel, cliProblem } from '../lib/cli-check';
import {
  VOICE_LANGS, emptyTranscript, foldResult, transcriptText, shouldRestartOnEnd,
  recognitionErrorAction, recognitionErrorMessage, voiceLinkAction,
} from '../lib/voice-capture';
import { refreshVoiceWidget } from '../widget/task-handler';
import { Button } from './ui';
import { haptic } from './feedback';
import { errorText } from './ErrorDialog';

type Phase = 'idle' | 'listening' | 'finishing' | 'sending' | 'error';

// stop() should be followed by a final result and an 'end' event; if the recognizer
// never sends them, deliver what we have rather than spinning forever.
const FINISH_FALLBACK_MS = 1500;
const BUTTON_SIZE = 116;

export default function VoiceSheet(
  { ready, paired, onSession }: { ready: boolean; paired: boolean; onSession: (id: string) => void },
) {
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [source, setSourceState] = useState<VoiceSource>('widget');
  const [transcript, setTranscript] = useState(emptyTranscript());
  const [lang, setLangState] = useState(VOICE_LANGS[0].id);
  const [problem, setProblem] = useState<{ title: string; message: string } | null>(null);

  // Recognizer events and voice requests arrive outside React's render, so the
  // current values live in refs as well as state.
  const phaseRef = useRef<Phase>('idle');
  const sourceRef = useRef<VoiceSource>('widget');
  const transcriptRef = useRef(emptyTranscript());
  const langRef = useRef(lang);
  const startingRef = useRef(false);
  const creatingRef = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
    refreshVoiceWidget(p === 'listening');
  };
  const setSource = (s: VoiceSource) => { sourceRef.current = s; setSourceState(s); };
  const setHeard = (t: ReturnType<typeof emptyTranscript>) => { transcriptRef.current = t; setTranscript(t); };

  useEffect(() => {
    getVoiceLang().then((l) => { langRef.current = l; setLangState(l); });
    // A widget left saying "Listening" by an app that was killed mid-capture.
    refreshVoiceWidget(false);
  }, []);

  const beginRecognition = () => {
    ExpoSpeechRecognitionModule.start({
      lang: langRef.current,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    });
  };

  const fail = (title: string, message: string) => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    ExpoSpeechRecognitionModule.abort();
    setProblem({ title, message });
    setPhase('error');
    haptic.error();
  };

  const start = async (from: VoiceSource) => {
    if (startingRef.current || phaseRef.current === 'listening' || phaseRef.current === 'sending') return;
    startingRef.current = true;
    setSource(from);
    setHeard(emptyTranscript());
    setProblem(null);
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) return fail('Microphone is off', recognitionErrorMessage('not-allowed'));
      haptic.tap();
      setPhase('listening');
      beginRecognition();
    } catch (e) {
      fail('Could not start listening', errorText(e));
    } finally {
      startingRef.current = false;
    }
  };

  const deliver = () => {
    if (phaseRef.current !== 'finishing') return;
    if (finishTimer.current) clearTimeout(finishTimer.current);
    if (!transcriptText(transcriptRef.current)) {
      fail('Nothing heard', 'No words came through. Hold the phone closer and try again.');
      return;
    }
    setPhase('sending');
  };

  const finish = () => {
    // Released before listening began (the permission prompt took the touch): the
    // hold can't end a capture that hasn't started, so it becomes tap-to-send.
    if (startingRef.current) return setSource('widget');
    if (phaseRef.current !== 'listening') return;
    haptic.tap();
    setPhase('finishing');
    ExpoSpeechRecognitionModule.stop();
    finishTimer.current = setTimeout(deliver, FINISH_FALLBACK_MS);
  };

  const close = () => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    if (phaseRef.current === 'listening' || phaseRef.current === 'finishing') ExpoSpeechRecognitionModule.abort();
    setPhase('idle');
  };

  // The handlers close over refs only, so one subscription for the sheet's lifetime.
  const handlers = useRef({ start, finish, close });
  handlers.current = { start, finish, close };
  useEffect(() => onVoiceRequest((r) => {
    const h = handlers.current;
    if (r.kind === 'start') h.start(r.source);
    else if (r.kind === 'finish') h.finish();
    else if (r.kind === 'cancel') h.close();
    else {
      const action = voiceLinkAction(phaseRef.current);
      if (action === 'start') h.start('widget');
      else if (action === 'finish') h.finish();
    }
  }), []);

  useSpeechRecognitionEvent('result', (e) => {
    if (phaseRef.current !== 'listening' && phaseRef.current !== 'finishing') return;
    setHeard(foldResult(transcriptRef.current, { transcript: e.results[0]?.transcript, isFinal: e.isFinal }));
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (recognitionErrorAction(e.error, phaseRef.current) === 'fail') {
      fail('Listening stopped', recognitionErrorMessage(e.error));
    }
  });
  useSpeechRecognitionEvent('end', () => {
    if (shouldRestartOnEnd(phaseRef.current)) beginRecognition();
    else if (phaseRef.current === 'finishing') deliver();
  });

  // Volume drives the glow behind the button, so it visibly hears you.
  const level = useRef(new Animated.Value(0)).current;
  useSpeechRecognitionEvent('volumechange', (e) => {
    const normalized = Math.max(0, Math.min(1, (e.value + 2) / 12));
    Animated.timing(level, { toValue: normalized, duration: 90, useNativeDriver: true }).start();
  });

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (phase !== 'listening') { pulse.stopAnimation(); pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(pulse, {
      toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  // A finished transcript waits here until the desktop is reachable.
  useEffect(() => {
    if (phase !== 'sending' || creatingRef.current) return;
    if (!paired) {
      fail('Not paired', 'Pair this phone with your desktop first — scan the QR code in its Settings → Remote access.');
      return;
    }
    if (!ready || !conn) return;
    creatingRef.current = true;
    (async () => {
      try {
        const model = await getSessionModel();
        const check = await conn.req<any>(cliCheckChannel(model)).catch(() => null);
        const missing = cliProblem(cliForModel(model), check);
        if (missing) return fail(missing.title, missing.message);
        const id = await newSessionWithPrompt(conn, transcriptText(transcriptRef.current), { model });
        haptic.success();
        setPhase('idle');
        onSession(id);
      } catch (e) {
        fail('Could not create session', errorText(e));
      } finally {
        creatingRef.current = false;
      }
    })();
  }, [phase, ready, paired, conn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase === 'idle') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => sub.remove();
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickLang = (id: string) => {
    if (id === langRef.current) return;
    haptic.tap();
    langRef.current = id;
    setLangState(id);
    setVoiceLang(id);
    // Abort rather than stop: the 'end' that follows restarts in the new language,
    // and what was already heard is kept.
    if (phaseRef.current === 'listening') ExpoSpeechRecognitionModule.abort();
  };

  if (phase === 'idle') return null;

  const heard = transcriptText(transcript);
  const hasText = heard !== '';

  if (phase === 'sending') {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={[styles.card, { bottom: insets.bottom + space.xl }]}>
          <Ionicons name="mic" size={18} color={color.accent} />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>{ready ? 'Starting session…' : 'Waiting for your desktop…'}</Text>
            <Text style={styles.cardText} numberOfLines={2}>{heard}</Text>
          </View>
          <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel">
            <Ionicons name="close" size={20} color={color.muted} />
          </Pressable>
        </View>
      </View>
    );
  }

  const listening = phase === 'listening';
  const hue = phase === 'error' ? color.faint : listening ? color.red : color.accent;
  const ring = {
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }],
  };
  const glow = {
    opacity: level.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.5] }),
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
  };
  const title = phase === 'error' ? problem?.title ?? 'Something went wrong'
    : listening ? 'Listening…' : 'Finishing…';
  const hint = listening
    ? (source === 'hold' ? 'Release to start the session' : 'Tap the button to start the session')
    : '';

  return (
    <View style={[styles.sheet, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl }]}>
      <View style={styles.top}>
        <View style={styles.langs}>
          {VOICE_LANGS.map((l) => (
            <Pressable
              key={l.id}
              onPress={() => pickLang(l.id)}
              style={[styles.lang, l.id === lang && styles.langOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: l.id === lang }}
            >
              <Text style={[styles.langText, l.id === lang && styles.langTextOn]}>{l.label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={close} hitSlop={12} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Cancel">
          <Ionicons name="close" size={22} color={color.muted} />
        </Pressable>
      </View>

      <View style={styles.center}>
        <Text style={styles.kicker}>NEW SESSION</Text>
        <View style={styles.buttonWrap}>
          {listening && <Animated.View style={[styles.halo, { backgroundColor: hue }, ring]} />}
          {listening && <Animated.View style={[styles.halo, { backgroundColor: hue }, glow]} />}
          <Pressable
            onPress={listening ? finish : phase === 'error' ? () => start('widget') : undefined}
            style={({ pressed }) => [styles.mic, { backgroundColor: hue }, pressed && styles.micPressed]}
            accessibilityRole="button"
            accessibilityLabel={listening ? 'Start the session' : 'Try again'}
          >
            <Ionicons name={listening ? 'stop' : phase === 'error' ? 'refresh' : 'mic'} size={44} color="#fff" />
          </Pressable>
        </View>
        <Text style={styles.title}>{title}</Text>
        {!!hint && <Text style={styles.hint}>{hint}</Text>}
        {phase === 'error' && !!problem && <Text style={styles.problem}>{problem.message}</Text>}
        <ScrollView style={styles.transcriptBox} contentContainerStyle={styles.transcriptInner}>
          <Text style={[styles.transcript, !hasText && styles.placeholder]}>
            {hasText ? heard : listening ? 'Say what Claude should do…' : ''}
          </Text>
        </ScrollView>
      </View>

      <View style={styles.actions}>
        <Button label="Cancel" tone="secondary" onPress={close} style={styles.action} />
        {listening && (
          <Button label="Start session" icon="arrow-up" hue={color.accentDim} onPress={finish} style={styles.action} />
        )}
        {phase === 'error' && hasText && (
          <Button label="Send again" icon="arrow-up" hue={color.accentDim} onPress={() => setPhase('sending')} style={styles.action} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { ...StyleSheet.absoluteFillObject, backgroundColor: alpha(color.bg, 0.97), paddingHorizontal: space.lg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  langs: { flexDirection: 'row', backgroundColor: color.surface, borderRadius: radius.pill, padding: 3, borderWidth: 1, borderColor: color.borderSoft },
  lang: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.pill },
  langOn: { backgroundColor: color.raisedHi },
  langText: { color: color.muted, fontSize: 13, fontWeight: '600', letterSpacing: 0.4 },
  langTextOn: { color: color.text },
  closeBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { ...type.category, color: color.faint, marginBottom: space.xl },
  buttonWrap: { width: BUTTON_SIZE * 1.8, height: BUTTON_SIZE * 1.8, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: BUTTON_SIZE, height: BUTTON_SIZE, borderRadius: BUTTON_SIZE / 2 },
  mic: {
    width: BUTTON_SIZE, height: BUTTON_SIZE, borderRadius: BUTTON_SIZE / 2, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  micPressed: { transform: [{ scale: 0.96 }] },
  title: { fontSize: 22, fontWeight: '700', color: color.text, marginTop: space.lg },
  hint: { ...type.meta, marginTop: space.xs },
  problem: { fontSize: 14, color: color.body, textAlign: 'center', marginTop: space.sm, maxWidth: 320, lineHeight: 20 },
  transcriptBox: { maxHeight: 180, alignSelf: 'stretch', marginTop: space.xl },
  transcriptInner: { paddingHorizontal: space.sm },
  transcript: { fontSize: 19, lineHeight: 27, color: color.text, textAlign: 'center' },
  placeholder: { color: color.faint },
  actions: { flexDirection: 'row', gap: space.md },
  action: { flex: 1 },
  card: {
    position: 'absolute', left: space.lg, right: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 16,
  },
  cardBody: { flex: 1 },
  cardTitle: { ...type.cardTitle, fontSize: 15 },
  cardText: { ...type.meta, marginTop: 2 },
});
