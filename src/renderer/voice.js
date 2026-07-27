// Voice input: while the mouse cursor rests over a session terminal, the
// microphone is live and what the user says is typed into that session.
//
// The interaction is cursor-driven on purpose — no hotkey, no button. That makes
// three guards non-negotiable, because a hot mic that fires by accident is worse
// than no feature:
//   * a dwell delay, so crossing the terminal on the way to another pane doesn't
//     start listening;
//   * a window-focus check, so hovering while another app is focused is inert;
//   * a visible indicator on the terminal that is listening.
//
// Only the audio capture lives here. Recognition (Whisper + Silero VAD) is in the
// main process (src/main/stt.js), which pushes back finished phrases as `stt-text`.
// Text is *typed into the session, never submitted* — the user reviews it and
// presses Enter themselves.
import { t } from '../i18n/index.js';
import { showWarning } from './shared/warn.js';

const STORE = { enabled: 'ide.voiceEnabled', model: 'ide.voiceModel' };
const DEFAULT_MODEL = 'turbo';

// Long enough that a cursor passing over a terminal doesn't arm the mic, short
// enough that deliberately pointing at one feels immediate.
const DWELL_MS = 300;
// The mic stream is kept open between hovers (acquiring it costs 200-500ms, which
// would eat the first words of a phrase) but not forever — the OS mic indicator
// staying lit while the user has moved on reads as spyware.
const IDLE_RELEASE_MS = 3 * 60 * 1000;

// Whether main reports usable speech weights. Distinct from the user's preference:
// the feature can be switched on in storage while the models are missing.
let available = true;
let stream = null;
let ctx = null;
let node = null;
let starting = null;      // in-flight arm, so a fast hover-out can await it
let armedSession = null;  // session id currently being dictated into
let dwellTimer = null;
let idleTimer = null;
let hoveredSession = null;
// Last known cursor position, so enabling the feature can act on where the mouse
// already is instead of waiting for it to move. Kept as scalars — this is written
// on every pointermove, and an object per event is pure GC churn.
let lastX = 0;
let lastY = 0;
let havePointer = false;
// The live indicator, held directly rather than re-queried: disarm runs on every
// move onto a non-terminal element, and scanning the document for it each time is
// wasted work when there is only ever one.
let hotPill = null;
let hotContainer = null;
// Whether we've already typed a phrase into the current hover. Decides whether the
// next phrase needs a leading space. Reset per arm — we can't see the terminal's
// real line contents, so each hover starts a fresh "line" as far as spacing goes.
let typedThisArm = false;

export function isVoiceEnabled() { return localStorage.getItem(STORE.enabled) === '1'; }
export function getVoiceModel() { return localStorage.getItem(STORE.model) || DEFAULT_MODEL; }

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
  // Paint "starting" before any awaiting, so the hover is acknowledged instantly
  // even on the first arm of the session (mic acquisition + a cold model load).
  showHot(containerFor(sessionId), 'starting');
  const attempt = armNow(sessionId).catch(disableVoice).finally(() => {
    if (starting === attempt) starting = null;
  });
  starting = attempt;
}

async function armNow(sessionId) {
  // The mic (renderer) and the recognizer (main) load independently, so don't pay
  // for them one after the other on a cold first hover.
  const [, res] = await Promise.all([
    ctx ? null : buildGraph(),
    window.api.sttStart({ sessionId, modelId: getVoiceModel() }),
  ]);
  if (res && res.error) throw new Error(res.error);
  // The cursor may have left while the weights were loading.
  if (hoveredSession !== sessionId) { hideHot(); window.api?.sttStop?.(); return; }
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
// `hoveredSession` has moved on and bails out on its own.
function disarm() {
  hideHot();
  if (!armedSession) return;
  gate(false);
  armedSession = null;
  // Flushes the phrase in progress in main: the user stopped hovering mid-sentence,
  // but they still said the words.
  window.api?.sttStop?.();
  scheduleIdleRelease();
}

// --- hover tracking ----------------------------------------------------------

function sessionUnder(target) {
  if (!(target instanceof Element)) return null;
  const container = target.closest('.term-container');
  if (!container || container.classList.contains('suspended')) return null;
  return container.dataset.sessionId || null;
}

// Both `pointerover` and `pointermove` feed this. `pointerover` alone is not
// enough: it only fires when the cursor *enters a new element*, so a cursor already
// resting over the terminal — the normal case right after closing the Settings
// dialog where voice input was just switched on — would never arm until the user
// deliberately left the pane and came back.
function onPointerActivity(e) {
  if (typeof e.clientX === 'number') { lastX = e.clientX; lastY = e.clientY; havePointer = true; }
  // Fires up to ~120x a second anywhere in the window, and the feature is off by
  // default — so bail before the ancestor walk rather than resolving a session
  // whose answer would be thrown away.
  if (!active()) return;
  hoverTo(sessionUnder(e.target));
}

// Only reacts to a *change* of hovered session, which is what makes the pointermove
// path cheap.
function hoverTo(id) {
  if (id === hoveredSession) return;
  applyHover(id);
}

function applyHover(id) {
  hoveredSession = id;
  clearTimeout(dwellTimer);
  if (!id || !active()) { disarm(); return; }
  // Hovering while another application is focused must be inert — the user isn't
  // talking to this app.
  if (!document.hasFocus()) { disarm(); return; }
  dwellTimer = setTimeout(() => {
    if (hoveredSession === id && active() && document.hasFocus()) arm(id);
  }, DWELL_MS);
}

// Re-read what the cursor is over right now, without waiting for it to move. Needed
// when the *feature* changes rather than the cursor: switching voice input on while
// already pointing at a terminal must start listening. Goes through applyHover, not
// hoverTo, because the resolved session is usually the one already stored.
function reevaluateHover() {
  if (!havePointer) return;
  applyHover(sessionUnder(document.elementFromPoint(lastX, lastY)));
}

function onPointerOut(e) {
  // Moving between children of the same container is not a leave.
  if (e.relatedTarget && sessionUnder(e.relatedTarget) === hoveredSession) return;
  hoverTo(sessionUnder(e.relatedTarget));
}

// --- text delivery -----------------------------------------------------------

function onText(msg) {
  if (!msg || !msg.text) return;
  // Only ever type into the session the phrase was captured for, even if the
  // cursor has since moved somewhere else.
  const id = msg.sessionId;
  if (!id) return;
  const text = typedThisArm ? ` ${msg.text}` : msg.text;
  typedThisArm = true;
  window.api.sendInput(id, text);
}

// --- settings section --------------------------------------------------------

export function setVoiceEnabled(on) {
  localStorage.setItem(STORE.enabled, on ? '1' : '0');
  if (!on) { clearTimeout(dwellTimer); disarm(); releaseStream(); return; }
  // Load the weights now, not on the first hover — the model load is ~2.7s and
  // would otherwise swallow the first words the user says. Deliberately does not
  // touch the microphone: that would light the OS recording indicator while the
  // user isn't even hovering a terminal.
  window.api?.sttWarm?.({ modelId: getVoiceModel() });
  // The user very likely just closed the Settings dialog with the cursor already
  // over a terminal. Arm from where the mouse is, rather than making them move it
  // out of the pane and back to discover that the feature works.
  reevaluateHover();
}

function setVoiceModel(id) {
  localStorage.setItem(STORE.model, id);
  // Drop the loaded recognizer so the switch takes effect even if the user never
  // toggles the feature off, then warm the new one straight away.
  window.api?.sttRelease?.();
  if (active()) window.api?.sttWarm?.({ modelId: id });
}

// Fill the model dropdown and enable/disable the section from what main reports is
// actually on disk. A model whose weights are missing is listed but not selectable,
// so a failed install-time fetch is visible rather than a mysteriously empty menu.
export async function refreshVoiceSection() {
  const box = document.getElementById('settings-voice');
  const sel = document.getElementById('settings-voice-model');
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

  const usable = !!(status && status.available);
  available = usable;
  box.disabled = !usable;
  sel.disabled = !usable;
  box.checked = usable && isVoiceEnabled();
  if (note) {
    note.textContent = usable ? '' : (status && status.error) || t('voice.unavailable');
    note.hidden = usable;
  }
}

export function initVoice() {
  // A user who left the feature on gets the weights loaded up front, so their first
  // hover is as responsive as every later one — but *after* the app has settled.
  // The load pulls in a native module and ~1 GB of weights, and startup is exactly
  // when sessions and terminals are being restored.
  if (isVoiceEnabled()) {
    const warm = () => window.api?.sttWarm?.({ modelId: getVoiceModel() });
    if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 2000);
  }

  const box = document.getElementById('settings-voice');
  const sel = document.getElementById('settings-voice-model');
  if (box) box.onchange = () => setVoiceEnabled(box.checked);
  if (sel) sel.onchange = () => setVoiceModel(sel.value);

  // Delegated so terminals created later are covered without re-binding.
  // `pointermove` is what catches a cursor that is already parked over a terminal;
  // it's cheap because it returns immediately unless the feature is on, and then
  // unless the resolved session changed. `pointerover` stays for the case where the
  // DOM changes under a stationary cursor (a session's terminal being built).
  document.addEventListener('pointerover', onPointerActivity, true);
  document.addEventListener('pointermove', onPointerActivity, true);
  document.addEventListener('pointerout', onPointerOut, true);
  // Alt-tabbing away with the cursor parked over a terminal must stop the mic.
  window.addEventListener('blur', () => { clearTimeout(dwellTimer); disarm(); });
  // Coming back to the window with the cursor still over a terminal should resume
  // listening — the blur above disarmed it.
  window.addEventListener('focus', () => reevaluateHover());

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
