// The listening sheet: speak a task, and a new session starts with it as the first
// prompt. Opened by the home-screen widget (tap to start, tap again — on the widget or
// here — to send) or by holding New session (let go to send).
//
// It is a plain absolutely-positioned View above the navigator, not a <Modal>: a
// Modal is a separate Android window, and opening one under a finger that is holding
// New session cancels that press — the hold would "release" the instant the sheet
// appeared. A View on top leaves the Pressable as the touch responder.
//
// What gets sent is not the phone's own transcript: its recognizer runs one language
// per capture and mangles a Turkish + English mix, so it only draws the live preview
// while the clip it records (Android 13+) goes to the desktop's Whisper —
// `stt-transcribe-clip`, the same model and TR+EN fence as desktop dictation. The
// phone's text is the fallback when the desktop can't transcribe.
//
// Holding New session opens the mic on the *press*, unseen (`arm`), and only shows
// the sheet at the hold threshold (`reveal`); a tap drops it (`disarm`). The
// recognizer takes a few hundred ms to come up, and starting it at the threshold
// made every hold feel late and cost the first word.
//
// The capture can outrun the connection (a cold start from the widget is still
// dialling the desktop while you talk), so a finished transcript waits for `ready`
// and then creates the session; while it waits the sheet shrinks to a bottom card so
// the window chooser behind it stays usable.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as FileSystem from 'expo-file-system';
import { ExpoSpeechRecognitionModule, supportsRecording, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { alpha, color, radius, space, type } from '../theme';
import { useConnection } from '../api/context';
import { getSessionModel } from '../api/models';
import { newSessionWithPrompt } from '../api/session-prompt';
import { onVoiceRequest, type VoiceSource } from '../api/voice';
import { cliCheckChannel, cliForModel, cliProblem } from '../lib/cli-check';
import {
  WHISPER_LANGUAGE, PREVIEW_LOCALE, CODING_TERMS, emptyTranscript, foldResult, transcriptText,
  shouldRestartOnEnd, recognitionErrorAction, recognitionErrorMessage, voiceLinkAction, canArmSilently,
  pickFinalTranscript, slideCancelProgress, SLIDE_CANCEL_PX,
} from '../lib/voice-capture';
import { refreshVoiceWidget } from '../widget/task-handler';
import { Button } from './ui';
import { haptic } from './feedback';
import { errorText } from './ErrorDialog';

type Phase = 'idle' | 'listening' | 'finishing' | 'sending' | 'error';

// stop() should be followed by a final result and an 'end' event; if the recognizer
// never sends them, deliver what we have rather than spinning forever.
const FINISH_FALLBACK_MS = 1500;
// Whisper decodes a phrase in ~1–3 s on the desktop; a long task is several phrases.
const TRANSCRIBE_TIMEOUT_MS = 60_000;

// Recordings are only for the desktop to transcribe; never keep them on the phone.
const deleteClips = (uris: string[]) => {
  uris.forEach((uri) => { FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); });
};
const BUTTON_SIZE = 116;

export default function VoiceSheet(
  { ready, paired, onSession }: { ready: boolean; paired: boolean; onSession: (id: string) => void },
) {
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [source, setSourceState] = useState<VoiceSource>('widget');
  const [transcript, setTranscript] = useState(emptyTranscript());
  const [hidden, setHiddenState] = useState(false);
  const [sendStep, setSendStep] = useState<'transcribing' | 'starting'>('transcribing');
  const [problem, setProblem] = useState<{ title: string; message: string } | null>(null);

  // Recognizer events and voice requests arrive outside React's render, so the
  // current values live in refs as well as state.
  const phaseRef = useRef<Phase>('idle');
  const sourceRef = useRef<VoiceSource>('widget');
  const transcriptRef = useRef(emptyTranscript());
  const startingRef = useRef(false);
  const creatingRef = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Armed by a press but not yet a hold: listening, with nothing on screen.
  const hiddenRef = useRef(false);
  const micGrantedRef = useRef(false);
  // The capture's recorded clips (one per recognizer run), and whether one is still
  // being written — a clip is only safe to read after its 'audioend'.
  const clipsRef = useRef<string[]>([]);
  const audioOpenRef = useRef(false);

  const setHidden = (h: boolean) => { hiddenRef.current = h; setHiddenState(h); };
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
    if (!hiddenRef.current) refreshVoiceWidget(p === 'listening');
  };
  const resetCapture = () => {
    deleteClips(clipsRef.current);
    clipsRef.current = [];
    audioOpenRef.current = false;
    setHeard(emptyTranscript());
    setProblem(null);
  };
  const setSource = (s: VoiceSource) => { sourceRef.current = s; setSourceState(s); };
  const setHeard = (t: ReturnType<typeof emptyTranscript>) => { transcriptRef.current = t; setTranscript(t); };

  useEffect(() => {
    ExpoSpeechRecognitionModule.getPermissionsAsync()
      .then((p) => { micGrantedRef.current = p.granted; })
      .catch(() => {});
    // A widget left saying "Listening" by an app that was killed mid-capture.
    refreshVoiceWidget(false);
  }, []);

  const beginRecognition = () => {
    ExpoSpeechRecognitionModule.start({
      lang: PREVIEW_LOCALE,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      contextualStrings: CODING_TERMS,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      // 16 kHz mono PCM16 WAV on Android — exactly what Whisper takes.
      ...(supportsRecording() ? { recordingOptions: { persist: true } } : {}),
    });
  };

  const fail = (title: string, message: string) => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    ExpoSpeechRecognitionModule.abort();
    // A press that never became a hold has nothing to report.
    if (hiddenRef.current) { disarm(); return; }
    setProblem({ title, message });
    setPhase('error');
    haptic.error();
  };

  const start = async (from: VoiceSource) => {
    if (startingRef.current || phaseRef.current === 'listening' || phaseRef.current === 'sending') return;
    startingRef.current = true;
    setHidden(false);
    setSource(from);
    resetCapture();
    try {
      const perm = micGrantedRef.current ? { granted: true } : await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      micGrantedRef.current = perm.granted;
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

  // New session pressed: start listening before we know it's a hold.
  const arm = () => {
    if (!canArmSilently(phaseRef.current, micGrantedRef.current) || startingRef.current) return;
    setHidden(true);
    setSource('hold');
    resetCapture();
    setPhase('listening');
    try { beginRecognition(); } catch { disarm(); }
  };

  // The hold threshold: show what is already listening, or — no permission yet, so
  // nothing was armed — start now, prompting for it.
  const reveal = () => {
    if (!hiddenRef.current) { start('hold'); return; }
    setHidden(false);
    haptic.tap();
    refreshVoiceWidget(true);
  };

  // Released before the threshold: it was a tap, so New session's own press runs.
  const disarm = () => {
    if (!hiddenRef.current) return;
    ExpoSpeechRecognitionModule.abort();
    setHidden(false);
    phaseRef.current = 'idle';
    setPhaseState('idle');
    resetCapture();
  };

  const deliver = () => {
    if (phaseRef.current !== 'finishing') return;
    if (finishTimer.current) clearTimeout(finishTimer.current);
    // No preview text is fine while there is audio: Whisper often hears what the
    // phone's single-language recognizer didn't (English said in Turkish mode).
    if (!transcriptText(transcriptRef.current) && !clipsRef.current.length) {
      fail('Nothing heard', 'No words came through. Hold the phone closer and try again.');
      return;
    }
    setSendStep('transcribing');
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
    setHidden(false);
    setPhase('idle');
    resetCapture();
  };

  // The handlers close over refs only, so one subscription for the sheet's lifetime.
  const handlers = useRef({ start, finish, close, arm, reveal, disarm });
  handlers.current = { start, finish, close, arm, reveal, disarm };
  // The held finger's leftward travel (−SLIDE_CANCEL_PX..0), reset per capture.
  const slideX = useRef(new Animated.Value(0)).current;
  useEffect(() => { if (phase !== 'listening') slideX.setValue(0); }, [phase, slideX]);

  useEffect(() => onVoiceRequest((r) => {
    const h = handlers.current;
    if (r.kind === 'start') h.start(r.source);
    else if (r.kind === 'arm') h.arm();
    else if (r.kind === 'reveal') h.reveal();
    else if (r.kind === 'disarm') h.disarm();
    // Straight onto the Animated value: ~60 moves a second must not re-render.
    else if (r.kind === 'slide') slideX.setValue(Math.max(-SLIDE_CANCEL_PX, Math.min(0, r.dx)));
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
  useSpeechRecognitionEvent('audiostart', () => { audioOpenRef.current = true; });
  useSpeechRecognitionEvent('audioend', (e) => {
    audioOpenRef.current = false;
    if (!e.uri) return;
    // A clip finishing after the capture was dropped belongs to nobody.
    if (phaseRef.current === 'idle') deleteClips([e.uri]);
    else clipsRef.current.push(e.uri);
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

  // The recorded clips through the desktop's Whisper. Null (→ the phone's own text)
  // when there is nothing complete to send or the desktop can't transcribe: an older
  // desktop rejects the channel, one without the voice model answers { error }.
  const transcribeOnDesktop = async (): Promise<{ text?: string } | null> => {
    const clips = clipsRef.current;
    if (!conn || !clips.length || audioOpenRef.current) return null;
    setSendStep('transcribing');
    try {
      const data = await Promise.all(clips.map((uri) =>
        FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })));
      return await conn.req<{ text?: string }>('stt-transcribe-clip',
        { clips: data, language: WHISPER_LANGUAGE }, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
    } catch {
      return null;
    }
  };

  // A finished capture waits here until the desktop is reachable.
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
        const text = pickFinalTranscript(await transcribeOnDesktop(), transcriptText(transcriptRef.current));
        if (!text) return fail('Nothing heard', 'No words came through. Hold the phone closer and try again.');
        // Shown on the card, and kept if creating fails so "Send again" sends it.
        setHeard({ finals: [text], interim: '' });
        setSendStep('starting');
        const model = await getSessionModel();
        const check = await conn.req<any>(cliCheckChannel(model)).catch(() => null);
        const missing = cliProblem(cliForModel(model), check);
        if (missing) return fail(missing.title, missing.message);
        const id = await newSessionWithPrompt(conn, text, { model });
        haptic.success();
        setPhase('idle');
        resetCapture();
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

  if (phase === 'idle' || hidden) return null;

  const heard = transcriptText(transcript);
  // Below Android 13 nothing is recorded, so the preview *is* what gets sent.
  const recording = supportsRecording();
  const hasText = heard !== '';

  if (phase === 'sending') {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={[styles.card, { bottom: insets.bottom + space.xl }]}>
          <Ionicons name="mic" size={18} color={color.accent} />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>
              {!ready ? 'Waiting for your desktop…' : sendStep === 'transcribing' ? 'Transcribing on your desktop…' : 'Starting session…'}
            </Text>
            {hasText && <Text style={styles.cardText} numberOfLines={2}>{heard}</Text>}
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
  const holding = listening && source === 'hold';
  const hint = listening
    ? (holding ? 'Release to start the session' : 'Tap the button to start the session')
    : '';
  // The slide hint follows the finger and reddens toward the cancel point.
  const slideProgress = slideX.interpolate({ inputRange: [-SLIDE_CANCEL_PX, 0], outputRange: [1, 0] });
  const slideStyle = { transform: [{ translateX: slideX }] };
  const slideRed = { opacity: slideProgress };

  return (
    <View style={[styles.sheet, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl }]}>
      <View style={styles.top}>
        {/* Not a switch — both languages are always on. It says so, because the
            preview under the button can only run one of them. */}
        <View style={styles.langs}>
          <Ionicons name="language-outline" size={14} color={color.muted} />
          <Text style={styles.langText}>Türkçe + English</Text>
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
          {listening && hasText && recording && (
            <Text style={styles.previewNote}>Preview · your desktop writes the final text</Text>
          )}
        </ScrollView>
      </View>

      {holding ? (
        <Animated.View style={[styles.slide, slideStyle]} accessibilityLabel="Slide left to cancel">
          <Animated.View style={[StyleSheet.absoluteFill, styles.slideRed, slideRed]} />
          <Ionicons name="chevron-back" size={18} color={color.muted} />
          <Ionicons name="chevron-back" size={18} color={color.faint} style={styles.slideChevron} />
          <Text style={styles.slideText}>Slide left to cancel</Text>
        </Animated.View>
      ) : (
      <View style={styles.actions}>
        <Button label="Cancel" tone="secondary" onPress={close} style={styles.action} />
        {listening && (
          <Button label="Start session" icon="arrow-up" hue={color.accentDim} onPress={finish} style={styles.action} />
        )}
        {phase === 'error' && hasText && (
          <Button label="Send again" icon="arrow-up" hue={color.accentDim} onPress={() => setPhase('sending')} style={styles.action} />
        )}
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { ...StyleSheet.absoluteFillObject, backgroundColor: alpha(color.bg, 0.97), paddingHorizontal: space.lg },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  langs: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: color.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderSoft,
  },
  langText: { color: color.muted, fontSize: 13, fontWeight: '600' },
  previewNote: { ...type.meta, color: color.faint, textAlign: 'center', marginTop: space.sm },
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
  slide: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', overflow: 'hidden',
    height: 48, paddingHorizontal: space.xl, borderRadius: radius.pill,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
  slideRed: { backgroundColor: alpha(color.red, 0.28) },
  slideChevron: { marginLeft: -10, marginRight: space.sm },
  slideText: { color: color.body, fontSize: 15, fontWeight: '600' },
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
