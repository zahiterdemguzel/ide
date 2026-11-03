// Voice input: while a session terminal has keyboard focus, the microphone is live
// and what the user says is typed into that session.
//
// **Focus, not the mouse.** Where the cursor happens to sit is irrelevant; the mic
// follows the caret. The rule is exactly "could I type into this panel right now?" —
// so the same act that makes a session ready for the keyboard makes it ready for the
// voice, and moving the mouse across the app can never open a microphone.
//
// Two guards remain non-negotiable, because a mic that opens without a button press
// is still a mic that opens on its own:
//   * a window-focus check, so a focused terminal in an unfocused window is inert;
//   * a visible indicator on the session that is listening.
//
// Only the audio capture lives here. Recognition (Whisper + Silero VAD) is in the
// main process (src/main/stt.js), which pushes back finished phrases as `stt-text`.
// Text is *typed into the session, never submitted* — the user reviews it and
// presses Enter themselves.
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
let starting = null;      // in-flight arm, so a focus change during it can bail out
let armedSession = null;  // session id currently being dictated into
let settleTimer = null;
let idleTimer = null;
let focusedSession = null; // session whose terminal currently holds the caret
// The live indicator, held directly rather than re-queried — there is only ever one.
let hotPill = null;
let hotContainer = null;
// Whether we've already typed a phrase into the current hover. Decides whether the
// next phrase needs a leading space. Reset per arm — we can't see the terminal's
// real line contents, so each hover starts a fresh "line" as far as spacing goes.
let typedThisArm = false;
// The New session hold in progress, or null. While it runs it owns the capture:
// dictation stands down and focus changes are ignored until it ends.
let hold = null;

export function isVoiceEnabled() { return localStorage.getItem(STORE.enabled) === '1'; }
export function getVoiceModel() { return localStorage.getItem(STORE.model) || DEFAULT_MODEL; }
export function getVoiceLanguage() { return localStorage.getItem(STORE.language) || DEFAULT_LANGUAGE; }

// What every stt-warm / stt-start call carries.
function engineOpts() { return { modelId: getVoiceModel(), language: getVoiceLanguage() }; }

// The single question the hover path asks: should a hover start listening?
function active() { return available && isVoiceEnabled(); }

// --- capture -----------------------------------------------------------------

async function buildGraph() {
  // 16 kHz is what Whisper consumes; asking the context for it means the browser
  // resamples the mic for us and the worklet can forward samples untouched.
  ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  // Independent: compiling the worklet module and acquiring the device share
  // nothing, and the device alone costs 200-500ms.
  const [, mic] = await Promise.all([
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
  stream = mic;
  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = (e) => {
    if (armedSession || hold) window.api.sttAudio(e.data);
  };
  // The worklet has no output; connecting to the destination would echo the mic
  // back through the speakers.
  source.connect(node);
}

function gate(open) {
  if (node) node.port.postMessage({ gate: open });
}

function releaseStream() {
  gate(false);
  if (stream) { for (const track of stream.getTracks()) track.stop(); stream = null; }
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  node = null;
  window.api?.sttRelease?.();
}

function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!armedSession && !hold) releaseStream(); }, IDLE_RELEASE_MS);
}

// --- indicator ---------------------------------------------------------------

// The indicator has three states, and it appears the moment the hover arms rather
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

function arm(sessionId) {
  if (armedSession === sessionId || starting) return;
  clearTimeout(idleTimer);
  // Paint "starting" before any awaiting, so focusing a terminal is acknowledged
  // instantly even on the first arm (mic acquisition + a cold model load).
  showHot(containerFor(sessionId), 'starting');
  const attempt = armNow(sessionId).catch(disableVoice).finally(() => {
    if (starting === attempt) starting = null;
  });
  starting = attempt;
}

async function armNow(sessionId) {
  // The mic (renderer) and the recognizer (main) load independently, so don't pay
  // for them one after the other on a cold first arm.
  const [, res] = await Promise.all([
    ctx ? null : buildGraph(),
    window.api.sttStart({ sessionId, ...engineOpts() }),
  ]);
  if (res && res.error) throw new Error(res.error);
  // Focus may have moved on while the weights were loading.
  if (focusedSession !== sessionId) { hideHot(); window.api?.sttStop?.(); return; }
  armedSession = sessionId;
  typedThisArm = false;
  gate(true);
  showHot(containerFor(sessionId), 'listening');
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

// Clears the pill even when arming never completed — a "starting" pill left behind
// would claim the mic is live when it isn't. An arm still in flight sees
// `focusedSession` has moved on and bails out on its own.
function disarm() {
  hideHot();
  if (!armedSession) return;
  gate(false);
  armedSession = null;
  // Flushes the phrase in progress in main: focus left mid-sentence, but the user
  // still said the words.
  window.api?.sttStop?.();
  scheduleIdleRelease();
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

// Re-reads where the caret is and arms or disarms to match. Every trigger routes
// through here — a focus change, the window regaining focus, the feature being
// switched on — so there is one definition of "should this be listening".
function syncToFocus() {
  if (hold) return; // the hold owns the capture; endHold() re-syncs
  const id = active() && document.hasFocus() ? focusedTerminalSession() : null;
  if (id === focusedSession && (!id || armedSession === id || starting)) return;
  focusedSession = id;
  clearTimeout(settleTimer);
  if (!id) { disarm(); return; }
  // Let a click that moves focus between panes settle before opening the mic.
  settleTimer = setTimeout(() => {
    if (focusedSession === id && active() && document.hasFocus()) arm(id);
  }, SETTLE_MS);
}

// Re-read what the cursor is over right now, without waiting for it to move. Needed
// when the *feature* changes rather than the cursor: switching voice input on while
// --- text delivery -----------------------------------------------------------

function onText(msg) {
  if (!msg || !msg.text) return;
  // A phrase captured for the New session hold goes into its transcript, never
  // into a terminal.
  if (msg.sessionId === HOLD_TARGET) {
    if (hold) hold.transcript = appendPhrase(hold.transcript, msg.text);
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

const HOLD_LABEL_KEY = {
  starting: 'voice.starting',
  listening: 'voice.holdListening',
  transcribing: 'voice.transcribing',
};

function paintHold(h, state) {
  const { button, label, restLabel } = h;
  button.classList.add('voice-hold');
  button.dataset.voiceState = state;
  if (label) label.textContent = state ? t(HOLD_LABEL_KEY[state]) : restLabel;
}

function endHold() {
  const h = hold;
  hold = null;
  if (h) {
    clearTimeout(h.maxTimer);
    h.button.classList.remove('voice-hold');
    delete h.button.dataset.voiceState;
    if (h.label) h.label.textContent = h.restLabel;
  }
  scheduleIdleRelease();
  syncToFocus();
}

async function startHold(button, onTranscript) {
  // Dictation and the hold share one capture in main, so the hold takes it over.
  clearTimeout(settleTimer);
  focusedSession = null;
  disarm();
  clearTimeout(idleTimer);
  const label = button.querySelector('[data-i18n]');
  const h = {
    button, label, restLabel: label ? label.textContent : '', onTranscript,
    transcript: '', ready: false, released: false, cancelled: false, maxTimer: null,
  };
  hold = h;
  paintHold(h, 'starting');
  h.maxTimer = setTimeout(() => releaseHold(false), MAX_HOLD_MS);
  try {
    const [, res] = await Promise.all([
      ctx ? null : buildGraph(),
      window.api.sttStart({ sessionId: HOLD_TARGET, ...engineOpts() }),
    ]);
    if (res && res.error) throw new Error(res.error);
  } catch (err) {
    if (hold === h) endHold();
    showWarning(err && err.message ? err.message : String(err), t('voice.title'));
    return;
  }
  // Cancelled while the mic and weights were loading.
  if (hold !== h) { window.api?.sttStop?.(); return; }
  h.ready = true;
  // Let go before the engine was up: nothing was recorded, which finishHold reports.
  if (h.released) { finishHold(h); return; }
  gate(true);
  paintHold(h, 'listening');
}

function releaseHold(cancelled) {
  const h = hold;
  if (!h || h.released) return;
  h.released = true;
  h.cancelled = cancelled;
  clearTimeout(h.maxTimer);
  gate(false);
  if (cancelled) { window.api?.sttStop?.(); endHold(); return; }
  // Still starting: startHold picks the finish up once the engine is ready.
  if (h.ready) finishHold(h);
}

// Wait for main to decode the phrase still in progress, then act on the transcript.
async function finishHold(h) {
  paintHold(h, 'transcribing');
  try { await window.api.sttFinish(); } catch { /* act on what arrived */ }
  if (hold !== h) return;
  endHold();
  const outcome = holdOutcome(h.transcript, h.cancelled);
  if (outcome === 'create') h.onTranscript(h.transcript);
  else if (outcome === 'empty') showWarning(t('voice.holdEmpty'), t('voice.title'));
}

// Turn `button` into a hold-to-talk control. A plain click keeps doing whatever the
// button's own click handler does; only a press outlasting HOLD_TO_TALK_MS records.
export function initHoldToTalk(button, onTranscript) {
  if (!button) return;
  let pressTimer = null;
  let endedHold = false; // the click that ends a hold must not also make a plain session
  button.title = t('voice.holdHint');
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || button.disabled || hold) return;
    endedHold = false;
    cancelPress();
    // Captured, so letting go still ends the hold after the pointer drifts off.
    button.setPointerCapture?.(e.pointerId);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      endedHold = true;
      startHold(button, onTranscript);
    }, HOLD_TO_TALK_MS);
  });
  button.addEventListener('pointerup', () => { cancelPress(); releaseHold(false); });
  button.addEventListener('pointercancel', () => { cancelPress(); releaseHold(true); });
  // Capture phase on the target runs before the button's own onclick.
  button.addEventListener('click', (e) => {
    if (!endedHold) return;
    endedHold = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !hold || hold.released) return;
    e.preventDefault();
    e.stopPropagation();
    releaseHold(true);
  }, true);
}

// --- settings section --------------------------------------------------------

export function setVoiceEnabled(on) {
  localStorage.setItem(STORE.enabled, on ? '1' : '0');
  if (!on) { clearTimeout(settleTimer); focusedSession = null; disarm(); releaseStream(); return; }
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
  document.addEventListener('focusin', syncToFocus);
  document.addEventListener('focusout', () => setTimeout(syncToFocus, 0));
  // A focused terminal in an unfocused window must be inert — the user is talking to
  // some other app — and coming back should resume listening.
  // A hold is dropped too: the button can't be released in a window that lost focus.
  window.addEventListener('blur', () => { releaseHold(true); clearTimeout(settleTimer); focusedSession = null; disarm(); });
  window.addEventListener('focus', syncToFocus);

  window.api?.onSttText?.(onText);
  // Main tells us when a phrase is being decoded, so the pill can say
  // "Transcribing" instead of sitting silent for the ~1s that takes.
  window.api?.onSttBusy?.((msg) => {
    if (msg && msg.sessionId === HOLD_TARGET) {
      if (hold && !hold.released) paintHold(hold, msg.busy ? 'transcribing' : 'listening');
      return;
    }
    if (!msg || msg.sessionId !== armedSession) return;
    setHotState(msg.busy ? 'transcribing' : 'listening');
  });
  window.api?.onSttError?.((msg) => {
    if (msg && msg.message) showWarning(msg.message, t('voice.title'));
  });
}
