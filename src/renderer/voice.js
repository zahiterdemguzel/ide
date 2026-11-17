// Session gestures and optional focus-based dictation share microphone capture.
// Main runs Whisper + Silero VAD and returns phrases to type into the session.
import { t } from '../i18n/index.js';
import { showWarning } from './shared/warn.js';
import { HOLD_TARGET, HOLD_TO_TALK_MS, MAX_HOLD_MS, appendPhrase, holdOutcome } from './shared/hold-to-talk.js';

const STORE = { enabled: 'ide.voiceEnabled', model: 'ide.voiceModel', language: 'ide.voiceLanguage' };
const DEFAULT_MODEL = 'turbo';
// Matches DEFAULT_LANGUAGE in src/main/stt-lib.js (Turkish + English), which is the
// authority — main re-resolves whatever it's sent, so a drift here can't break it.
const DEFAULT_LANGUAGE = 'en-tr';

// Focus can flicker for a frame while a click moves it between panes (sidebar row →
// terminal), so a change is allowed to settle before it arms or disarms. Short
// enough that clicking into a terminal and speaking still feels immediate.
const SETTLE_MS = 120;
// About 16 seconds of worklet batches while Whisper loads or the previous
// session's final phrase finishes. A stalled engine cannot grow this buffer.
const MAX_PENDING_CHUNKS = 256;
// The mic stream is kept open between sessions (acquiring it costs 200-500ms, which
// would eat the first words of a phrase) but not forever — the OS mic indicator
// staying lit while the user has moved on reads as spyware.
const IDLE_RELEASE_MS = 3 * 60 * 1000;

// Whether main reports usable speech weights. Distinct from the user's preference:
// the feature can be switched on in storage while the models are missing.
let available = true;
let stream = null;
let ctx = null;
let node = null;
let graphLoading = null;  // in-flight mic graph build, shared by dictation and the hold
let starting = null;
let wanted = null; // identity distinguishes consecutive requests for the same session
let gestureSession = null;
let pausedSession = null; // a gesture stopped dictation while this session stayed focused
let engineChange = Promise.resolve();
let armedSession = null;  // session id currently being dictated into
let settleTimer = null;
let idleTimer = null;
// The live indicator, held directly rather than re-queried — there is only ever one.
let hotPill = null;
let hotContainer = null;
// Whether a phrase has already been typed during this capture.
let typedThisArm = false;
// The New session hold in progress, or null. While it runs it owns the capture:
// dictation stands down and focus changes are ignored until it ends.
let hold = null;

export function isVoiceEnabled() { return localStorage.getItem(STORE.enabled) === '1'; }
export function getVoiceModel() { return localStorage.getItem(STORE.model) || DEFAULT_MODEL; }
export function getVoiceLanguage() { return localStorage.getItem(STORE.language) || DEFAULT_LANGUAGE; }

// What every stt-warm / stt-start call carries.
function engineOpts() { return { modelId: getVoiceModel(), language: getVoiceLanguage() }; }

function active() { return available && isVoiceEnabled(); }

// --- capture -----------------------------------------------------------------

async function buildGraph() {
  // 16 kHz is what Whisper consumes; asking the context for it means the browser
  // resamples the mic for us and the worklet can forward samples untouched.
  ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  // Independent: compiling the worklet module and acquiring the device share
  // nothing, and the device alone costs 200-500ms.
  const [worklet, mic] = await Promise.allSettled([
    ctx.audioWorklet.addModule(new URL('./audio/pcm-worklet.js', import.meta.url)),
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  ]);
  if (mic.status === 'rejected') throw mic.reason;
  stream = mic.value;
  if (worklet.status === 'rejected') throw worklet.reason;
  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = (e) => {
    if (hold) captureForHold(hold, e.data);
    else if (armedSession) window.api.sttAudio(e.data);
    else if (wanted?.pending && wanted.pending.length < MAX_PENDING_CHUNKS) wanted.pending.push(e.data);
  };
  // The worklet has no output; connecting to the destination would echo the mic
  // back through the speakers.
  source.connect(node);
}

// One graph however many callers race for it: a hold pressed while dictation is
// still arming must not open a second AudioContext and microphone.
function ensureGraph() {
  if (node) return Promise.resolve();
  if (!graphLoading) {
    graphLoading = buildGraph()
      .catch((err) => { releaseMic(); throw err; })
      .finally(() => { graphLoading = null; });
  }
  return graphLoading;
}

function gate(open) {
  if (node) node.port.postMessage({ gate: open });
}

// The microphone only — the recognizer's weights stay loaded.
function releaseMic() {
  gate(false);
  if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  node = null;
}

function releaseStream() {
  releaseMic();
  window.api?.sttRelease?.();
}

function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!wanted && !starting && !hold) releaseStream(); }, IDLE_RELEASE_MS);
}

// --- indicator ---------------------------------------------------------------

// The indicator has three states, and it appears the moment dictation starts arming rather
// than when recognition is ready: the model load and each ~1s decode are both long
// enough that silence would read as "the feature is broken".
//   starting    — arming (loading weights / acquiring the mic)
//   listening   — mic live, waiting for speech
//   transcribing— a finished phrase is being decoded
const STATE_KEY = {
  starting: 'voice.starting',
  listening: 'voice.listening',
  transcribing: 'voice.transcribing',
};

function showHot(container, state) {
  if (!container) return;
  if (hotContainer && hotContainer !== container) hideHot();
  if (!hotPill) {
    hotPill = document.createElement('div');
    hotPill.className = 'voice-hot';
    hotPill.appendChild(document.createElement('span'));
    container.appendChild(hotPill);
    container.classList.add('voice-listening');
    hotContainer = container;
  }
  const label = t(STATE_KEY[state] || STATE_KEY.listening);
  hotPill.dataset.state = state;
  hotPill.title = label;
  hotPill.firstChild.textContent = label;
}

// Repaint the pill in place, if one is showing.
function setHotState(state) {
  if (hotPill) showHot(hotContainer, state);
}

function hideHot() {
  if (hotPill) { hotPill.remove(); hotPill = null; }
  if (hotContainer) { hotContainer.classList.remove('voice-listening'); hotContainer = null; }
}

// --- arm / disarm ------------------------------------------------------------

function containerFor(sessionId) {
  return document.querySelector(`.term-container[data-session-id="${CSS.escape(sessionId)}"]`);
}

// Let each stop flush the last phrase before changing the main process's target.
// This also orders a New session hold against dictation that was still arming.
function changeEngine(task) {
  const result = engineChange.then(task);
  engineChange = result.catch(() => {});
  return result;
}

function startEngine(sessionId, isCurrent) {
  return changeEngine(async () => {
    if (!isCurrent()) return false;
    const result = await window.api.sttStart({ sessionId, ...engineOpts() });
    if (!isCurrent()) {
      if (!result?.error) await window.api.sttFinish();
      return false;
    }
    if (result?.error) throw new Error(result.error);
    return true;
  });
}

function stopEngine() { return changeEngine(() => window.api.sttFinish()); }

function arm(request) {
  const { id } = request;
  if (request !== wanted || armedSession === id || starting) return;
  clearTimeout(idleTimer);
  showHot(containerFor(id), 'starting');
  starting = armNow(request).catch((err) => {
    if (wanted !== request) return;
    if (gestureSession === id) {
      stopGesture();
      showWarning(err.message || String(err), t('voice.title'));
    } else {
      disableVoice(err);
    }
  }).finally(() => {
    starting = null;
    if (wanted && wanted !== request && !settleTimer) arm(wanted);
    else if (!wanted && !hold && (!isVoiceEnabled() || pausedSession)) releaseMic();
  });
}

async function armNow(request) {
  await ensureGraph();
  if (wanted !== request) return;
  request.pending = [];
  gate(true);
  if (!await startEngine(request.id, () => wanted === request) || wanted !== request) return;
  armedSession = request.id;
  typedThisArm = false;
  for (const chunk of request.pending) window.api.sttAudio(chunk);
  request.pending = null;
  showHot(containerFor(request.id), 'listening');
}

// A denied mic permission or a missing model must switch the feature off rather
// than leave a toggle that claims to be listening and isn't. One place, so the
// teardown order (checkbox, storage, capture) can't drift between callers.
function disableVoice(err) {
  const box = document.getElementById('settings-voice');
  if (box) box.checked = false;
  setVoiceEnabled(false);
  if (err) showWarning(err.message ? err.message : String(err), t('voice.title'));
}

function disarm() {
  clearTimeout(settleTimer);
  settleTimer = null;
  wanted = null;
  hideHot();
  gate(false);
  if (armedSession) {
    armedSession = null;
    stopEngine();
  }
  if (!hold) {
    if (!starting && (!isVoiceEnabled() || pausedSession)) releaseMic();
    scheduleIdleRelease();
  }
}

// --- focus tracking ----------------------------------------------------------

// The session the caret is in, or null. A suspended pane has no live PTY behind it,
// so there is nothing to type into — the same reason it can't be typed into by hand.
function sessionOf(element) {
  if (!(element instanceof Element)) return null;
  const container = element.closest('.term-container');
  if (!container || container.classList.contains('suspended')) return null;
  return container.dataset.sessionId || null;
}

// xterm keeps a hidden textarea inside the pane and focuses that, so the caret is
// always on a descendant of `.term-container` rather than the container itself.
function focusedTerminalSession() {
  return sessionOf(document.activeElement);
}

function syncToFocus(immediate = false) {
  if (hold) return;
  const focused = document.hasFocus() ? focusedTerminalSession() : null;
  if (gestureSession !== focused) gestureSession = null;
  if (pausedSession !== focused) pausedSession = null;
  const id = gestureSession || (active() && focused !== pausedSession ? focused : null);
  if ((wanted?.id || null) !== id) {
    disarm();
    if (id) wanted = { id };
  }
  if (!wanted || armedSession === id) return;
  if (immediate) {
    clearTimeout(settleTimer);
    settleTimer = null;
    arm(wanted);
  } else if (!settleTimer && !starting) {
    const request = wanted;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      arm(request);
    }, SETTLE_MS);
  }
}

function stopGesture() {
  pausedSession = gestureSession;
  gestureSession = null;
  syncToFocus();
}

export function toggleSessionDictation(id) {
  if (hold || !document.hasFocus() || focusedTerminalSession() !== id) return;
  if (gestureSession === id) {
    stopGesture();
    return;
  }
  gestureSession = id;
  pausedSession = null;
  window.api.sttWarm(engineOpts());
  syncToFocus(true);
}

export function stopSessionDictation(id) {
  if (wanted?.id !== id) return;
  gestureSession = null;
  pausedSession = id;
  disarm();
}

// --- text delivery -----------------------------------------------------------

function onText(msg) {
  if (!msg || !msg.text) return;
  // A phrase captured for the New session hold goes into its transcript, never
  // into a terminal.
  if (msg.sessionId === HOLD_TARGET) {
    if (hold?.engineReady) hold.transcript = appendPhrase(hold.transcript, msg.text);
    return;
  }
  // Only ever type into the session the phrase was captured for, even if focus has
  // since moved somewhere else.
  const id = msg.sessionId;
  if (!id) return;
  const text = typedThisArm ? ` ${msg.text}` : msg.text;
  typedThisArm = true;
  window.api.sendInput(id, text);
}

// --- hold-to-talk on New session ---------------------------------------------
// Holding the New session button records the task by voice; letting go starts a
// session with the transcript as its first message, Esc cancels. Same engine and
// spoken language as dictation, but it doesn't need dictation switched on: the
// held button is the explicit act that opens the mic, and it lights up while it does.
//
// Nothing waits in line. The mic opens on the press itself and every chunk is kept
// from that instant, so the first word is never lost to getUserMedia, the 400 ms hold
// threshold or a cold model load — chunks are handed to main once it's ready. When
// the press becomes a recording the session starts booting in the background
// (`startDraft`), so letting go only waits for the last phrase to decode. A press
// released before the threshold was a click: its audio is dropped.

const HOLD_LABEL_KEY = {
  starting: 'voice.starting',
  listening: 'voice.holdListening',
  transcribing: 'voice.transcribing',
};

// The click that ends a recording must not also make a plain session.
let swallowNextClick = false;

function paintHold(h, state) {
  const { button, label } = h;
  button.classList.add('voice-hold');
  button.dataset.voiceState = state;
  if (label) label.textContent = t(HOLD_LABEL_KEY[state]);
}

function captureForHold(h, chunk) {
  if (h.released) return;
  if (h.engineReady) window.api.sttAudio(chunk);
  else h.pending.push(chunk);
}

function endHold(h) {
  if (hold !== h) return;
  hold = null;
  clearTimeout(h.pressTimer);
  clearTimeout(h.maxTimer);
  gate(false);
  h.button.classList.remove('voice-hold');
  delete h.button.dataset.voiceState;
  if (h.label) h.label.textContent = h.restLabel;
  // A plain click opened the mic only in case it became a hold: with dictation off,
  // close it now rather than leave the OS recording indicator lit.
  if (!isVoiceEnabled()) {
    (graphLoading || Promise.resolve()).then(() => {
      if (!hold && !wanted) releaseMic();
    }, () => {});
  }
  scheduleIdleRelease();
  syncToFocus();
}

function failHold(h, err) {
  if (hold !== h) return;
  h.released = true;
  if (h.engineReady) stopEngine();
  h.draft?.discard();
  endHold(h);
  showWarning(err && err.message ? err.message : String(err), t('voice.title'));
}

// The press itself: open the mic and start keeping audio, before we know whether
// this is a click or a hold.
function beginPress(button, startDraft) {
  // Dictation and the hold share one capture in main, so the hold takes it over.
  swallowNextClick = false;
  const label = button.querySelector('[data-i18n]');
  const h = {
    button, label, restLabel: label ? label.textContent : '', startDraft,
    pending: [], transcript: '', recording: false, engineReady: false,
    released: false, cancelled: false, micError: null, draft: null, pressTimer: null, maxTimer: null,
  };
  hold = h;
  gestureSession = null;
  disarm();
  clearTimeout(idleTimer);
  ensureGraph().then(() => {
    if (hold !== h || h.released) return;
    gate(true);
    if (h.recording) paintHold(h, 'listening');
  }, (err) => {
    h.micError = err;
    if (h.recording) failHold(h, err);
  });
  h.pressTimer = setTimeout(() => startRecording(h), HOLD_TO_TALK_MS);
}

function startRecording(h) {
  if (hold !== h || h.released) return;
  if (h.micError) { failHold(h, h.micError); return; }
  h.recording = true;
  swallowNextClick = true;
  paintHold(h, node ? 'listening' : 'starting');
  h.maxTimer = setTimeout(() => releaseHold(false), MAX_HOLD_MS);
  h.draft = h.startDraft ? h.startDraft() : null;
  startEngine(HOLD_TARGET, () => hold === h).then((started) => {
    if (!started || hold !== h) return;
    h.engineReady = true;
    for (const chunk of h.pending) window.api.sttAudio(chunk);
    h.pending = [];
    if (h.released) finishHold(h);
  }).catch((err) => failHold(h, err));
}

function releaseHold(cancelled) {
  const h = hold;
  if (!h || h.released) return;
  h.released = true;
  gate(false);
  // Let go before the threshold: a click, which the button's own handler takes.
  if (!h.recording) { endHold(h); return; }
  h.cancelled = cancelled;
  clearTimeout(h.maxTimer);
  if (cancelled) {
    if (h.engineReady) stopEngine();
    h.draft?.discard();
    endHold(h);
    return;
  }
  // Show the session the moment the button is let go; the text follows.
  h.draft?.reveal();
  // Still loading: startRecording finishes once main has the audio.
  if (h.engineReady) finishHold(h);
  else paintHold(h, 'transcribing');
}

// Wait for main to decode the phrase still in progress, then act on the transcript.
async function finishHold(h) {
  paintHold(h, 'transcribing');
  try { await stopEngine(); } catch { /* act on what arrived */ }
  if (hold !== h) return;
  endHold(h);
  const outcome = holdOutcome(h.transcript, h.cancelled);
  if (outcome === 'create') {
    if (h.draft) h.draft.submit(h.transcript);
  } else if (outcome === 'empty') {
    h.draft?.discard();
    showWarning(t('voice.holdEmpty'), t('voice.title'));
  }
}

// Turn `button` into a hold-to-talk control. A plain click keeps doing whatever the
// button's own click handler does; only a press outlasting HOLD_TO_TALK_MS records.
// `startDraft()` is called when it does, and returns the session being prepared:
// `{ reveal(), submit(text), discard() }` (see sessions.js startVoiceDraft).
export function initHoldToTalk(button, startDraft) {
  if (!button) return;
  if (!button.title) button.title = t('voice.holdHint');

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || button.disabled || hold) return;
    // Captured, so letting go still ends the hold after the pointer drifts off.
    button.setPointerCapture?.(e.pointerId);
    beginPress(button, startDraft);
  });
  button.addEventListener('pointerup', () => releaseHold(false));
  button.addEventListener('pointercancel', () => releaseHold(true));
  // Capture phase on the target runs before the button's own onclick.
  button.addEventListener('click', (e) => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

// --- settings section --------------------------------------------------------

export function setVoiceEnabled(on) {
  localStorage.setItem(STORE.enabled, on ? '1' : '0');
  if (!on) {
    gestureSession = null;
    disarm();
    changeEngine(() => { if (!wanted && !hold && !isVoiceEnabled()) window.api.sttRelease(); });
    return;
  }
  // Load the weights now, not on the first arm — the model load is ~2.7s and would
  // otherwise swallow the first words the user says. Deliberately does not touch the
  // microphone: that would light the OS recording indicator while no session is even
  // focused.
  window.api?.sttWarm?.(engineOpts());
  // The caret may already be in a terminal (the dialog was opened from one), so act
  // on where focus is rather than waiting for the user to click away and back.
  syncToFocus();
}

// The model is a load-time property of the recognizer, so changing it drops the
// loaded one and warms a fresh one — otherwise the switch wouldn't take effect until
// the user toggled the feature off and on.
function setModelChoice(value) {
  localStorage.setItem(STORE.model, value);
  window.api?.sttRelease?.();
  if (active()) window.api?.sttWarm?.(engineOpts());
}

// The language is set per decode in main, so it only needs storing; the next capture
// carries it. A capture already listening keeps the language it started with.
function setLanguageChoice(value) {
  localStorage.setItem(STORE.language, value);
}

// Fill the model dropdown and enable/disable the section from what main reports is
// actually on disk. A model whose weights are missing is listed but not selectable,
// so a failed install-time fetch is visible rather than a mysteriously empty menu.
export async function refreshVoiceSection() {
  const box = document.getElementById('settings-voice');
  const sel = document.getElementById('settings-voice-model');
  const langSel = document.getElementById('settings-voice-language');
  const note = document.getElementById('voice-note');
  if (!box || !sel) return;

  let status = null;
  try { status = await window.api.sttStatus(); } catch { status = null; }
  const models = (status && status.models) || [];

  sel.replaceChildren();
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.ready ? m.label : `${m.label} — ${t('voice.notDownloaded')}`;
    opt.disabled = !m.ready;
    if (m.id === getVoiceModel()) opt.selected = true;
    sel.appendChild(opt);
  }

  // Languages come from main so the offered list and the list the recognizer will
  // actually accept can't drift; the labels are ours to translate.
  if (langSel) {
    langSel.replaceChildren();
    for (const l of (status && status.languages) || []) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = t(l.labelKey);
      if (l.id === getVoiceLanguage()) opt.selected = true;
      langSel.appendChild(opt);
    }
  }

  const usable = !!(status && status.available);
  available = usable;
  box.disabled = !usable;
  sel.disabled = !usable;
  if (langSel) langSel.disabled = !usable;
  box.checked = usable && isVoiceEnabled();
  if (note) {
    note.textContent = usable ? '' : (status && status.error) || t('voice.unavailable');
    note.hidden = usable;
  }
}

export function initVoice() {
  // A user who left the feature on gets the weights loaded up front, so their first
  // dictation is as responsive as every later one — but *after* the app has settled.
  // The load pulls in a native module and ~1 GB of weights, and startup is exactly
  // when sessions and terminals are being restored.
  if (isVoiceEnabled()) {
    const warm = () => window.api?.sttWarm?.(engineOpts());
    if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 2000);
  }

  const box = document.getElementById('settings-voice');
  const sel = document.getElementById('settings-voice-model');
  const langSel = document.getElementById('settings-voice-language');
  if (box) box.onchange = () => setVoiceEnabled(box.checked);
  if (sel) sel.onchange = () => setModelChoice(sel.value);
  if (langSel) langSel.onchange = () => setLanguageChoice(langSel.value);

  // Delegated, so terminals created later are covered without re-binding. focusin
  // and focusout both bubble (unlike focus/blur), and both are needed: focusin
  // catches the caret arriving, focusout catches it leaving for something that never
  // takes focus itself (clicking blank chrome), where no focusin follows.
  document.addEventListener('focusin', () => syncToFocus());
  document.addEventListener('focusout', () => setTimeout(syncToFocus, 0));
  // A focused terminal in an unfocused window must be inert — the user is talking to
  // some other app — and coming back should resume listening.
  // A hold is dropped too: the button can't be released in a window that lost focus.
  window.addEventListener('blur', () => {
    releaseHold(true);
    gestureSession = null;
    pausedSession = null;
    disarm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (hold?.recording && !hold.released) releaseHold(true);
    else if (gestureSession) stopGesture();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  window.addEventListener('focus', () => syncToFocus());

  window.api?.onSttText?.(onText);
  // Main tells us when a phrase is being decoded, so the pill can say
  // "Transcribing" instead of sitting silent for the ~1s that takes.
  window.api?.onSttBusy?.((msg) => {
    // A held button keeps saying "Listening": the mic never stops while a phrase
    // decodes, and flashing "Transcribing" at every pause reads as if it had stopped
    // hearing. Only the release (finishHold) shows the decode of the last phrase.
    if (msg && msg.sessionId === HOLD_TARGET) return;
    if (!msg || msg.sessionId !== armedSession) return;
    setHotState(msg.busy ? 'transcribing' : 'listening');
  });
  window.api?.onSttError?.((msg) => {
    if (msg && msg.message) showWarning(msg.message, t('voice.title'));
  });
}
