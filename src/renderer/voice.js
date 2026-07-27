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

const STORE = { enabled: 'ide.voiceEnabled', model: 'ide.voiceModel', language: 'ide.voiceLanguage' };
const DEFAULT_MODEL = 'turbo';
// Matches DEFAULT_LANGUAGE in src/main/stt-lib.js, which is the authority — main
// re-resolves whatever it's sent, so a drift here degrades to English, not to broken.
const DEFAULT_LANGUAGE = 'en';

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
    if (armedSession) window.api.sttAudio(e.data);
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
  idleTimer = setTimeout(() => { if (!armedSession) releaseStream(); }, IDLE_RELEASE_MS);
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
  // Only ever type into the session the phrase was captured for, even if focus has
  // since moved somewhere else.
  const id = msg.sessionId;
  if (!id) return;
  const text = typedThisArm ? ` ${msg.text}` : msg.text;
  typedThisArm = true;
  window.api.sendInput(id, text);
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

// Model and language are both load-time properties of the recognizer, so changing
// either drops the loaded one and warms a fresh one — otherwise the switch wouldn't
// take effect until the user toggled the feature off and on.
function setEngineChoice(key, value) {
  localStorage.setItem(key, value);
  window.api?.sttRelease?.();
  if (active()) window.api?.sttWarm?.(engineOpts());
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
  if (sel) sel.onchange = () => setEngineChoice(STORE.model, sel.value);
  if (langSel) langSel.onchange = () => setEngineChoice(STORE.language, langSel.value);

  // Delegated, so terminals created later are covered without re-binding. focusin
  // and focusout both bubble (unlike focus/blur), and both are needed: focusin
  // catches the caret arriving, focusout catches it leaving for something that never
  // takes focus itself (clicking blank chrome), where no focusin follows.
  document.addEventListener('focusin', syncToFocus);
  document.addEventListener('focusout', () => setTimeout(syncToFocus, 0));
  // A focused terminal in an unfocused window must be inert — the user is talking to
  // some other app — and coming back should resume listening.
  window.addEventListener('blur', () => { clearTimeout(settleTimer); focusedSession = null; disarm(); });
  window.addEventListener('focus', syncToFocus);

  window.api?.onSttText?.(onText);
  // Main tells us when a phrase is being decoded, so the pill can say
  // "Transcribing" instead of sitting silent for the ~1s that takes.
  window.api?.onSttBusy?.((msg) => {
    if (!msg || msg.sessionId !== armedSession) return;
    setHotState(msg.busy ? 'transcribing' : 'listening');
  });
  window.api?.onSttError?.((msg) => {
    if (msg && msg.message) showWarning(msg.message, t('voice.title'));
  });
}
