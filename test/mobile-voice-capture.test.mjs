// Speaking a task into a new session from the phone (mobile/src/lib/voice-capture.js):
// the widget's deep link, the tap-to-start / tap-to-send toggle, and how recognizer
// results and errors fold into one prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import {
  VOICE_LINK, WHISPER_LANGUAGE, PREVIEW_LOCALE, isVoiceLink, voiceLinkAction,
  canArmSilently, pickFinalTranscript, HOLD_TO_TALK_MS,
  SLIDE_CANCEL_PX, slideCancelProgress, shouldCancelSlide,
  emptyTranscript, foldResult, transcriptText, shouldRestartOnEnd,
  recognitionErrorAction, recognitionErrorMessage,
} from '../mobile/src/lib/voice-capture.js';

test('isVoiceLink accepts the widget link and nothing else', () => {
  assert.equal(isVoiceLink(VOICE_LINK), true);
  assert.equal(isVoiceLink('ide://voice-session?from=widget'), true);
  assert.equal(isVoiceLink('IDE://Voice-Session/'), true);
  assert.equal(isVoiceLink('ide://voice-sessions'), false);
  assert.equal(isVoiceLink('ide://pair?relay=x'), false);
  assert.equal(isVoiceLink(null), false);
});

test('voiceLinkAction: first tap starts, second sends, a tap mid-create is ignored', () => {
  assert.equal(voiceLinkAction('idle'), 'start');
  assert.equal(voiceLinkAction('error'), 'start');
  assert.equal(voiceLinkAction('listening'), 'finish');
  assert.equal(voiceLinkAction('finishing'), 'ignore');
  assert.equal(voiceLinkAction('sending'), 'ignore');
});

test('every capture is transcribed in the desktop\'s Turkish + English mode — no language switch', () => {
  const desktop = require('../src/main/stt-lib.js');
  const mode = desktop.findLanguage(WHISPER_LANGUAGE);
  assert.ok(mode, 'a language the desktop knows');
  assert.deepEqual([...mode.fence].sort(), ['en', 'tr'], 'detects per phrase, fenced to Turkish and English');
  assert.equal(PREVIEW_LOCALE, 'tr-TR');
});

test('canArmSilently opens the mic on press only with permission and nothing showing', () => {
  assert.equal(canArmSilently('idle', true), true);
  assert.equal(canArmSilently('error', true), true);
  assert.equal(canArmSilently('idle', false), false);
  assert.equal(canArmSilently('sending', true), false);
  assert.ok(HOLD_TO_TALK_MS > 0 && HOLD_TO_TALK_MS <= 300);
});

test('pickFinalTranscript prefers the desktop Whisper text and falls back to the phone', () => {
  assert.equal(pickFinalTranscript({ text: ' login hatasını fix et ' }, 'login hatası fikset'), 'login hatasını fix et');
  assert.equal(pickFinalTranscript({ text: '' }, 'phone text'), 'phone text');
  assert.equal(pickFinalTranscript({ error: 'no model' }, 'phone text'), 'phone text');
  assert.equal(pickFinalTranscript(null, '  '), '');
});

test('foldResult: interim replaces the phrase in progress, final appends it', () => {
  let t = emptyTranscript();
  t = foldResult(t, { transcript: 'fix the', isFinal: false });
  t = foldResult(t, { transcript: 'fix the login bug', isFinal: false });
  assert.deepEqual(t, { finals: [], interim: 'fix the login bug' });
  t = foldResult(t, { transcript: 'fix the login bug ', isFinal: true });
  t = foldResult(t, { transcript: 'and add a test', isFinal: false });
  assert.deepEqual(t, { finals: ['fix the login bug'], interim: 'and add a test' });
  assert.equal(transcriptText(t), 'fix the login bug and add a test');
});

test('foldResult drops an empty final without losing earlier phrases', () => {
  const t = foldResult({ finals: ['one'], interim: 'tw' }, { transcript: '', isFinal: true });
  assert.deepEqual(t, { finals: ['one'], interim: '' });
});

test('transcriptText is empty when nothing was heard', () => {
  assert.equal(transcriptText(emptyTranscript()), '');
  assert.equal(transcriptText({ finals: [], interim: '   ' }), '');
});

test('the recognizer is restarted only while the user is still talking', () => {
  assert.equal(shouldRestartOnEnd('listening'), true);
  assert.equal(shouldRestartOnEnd('finishing'), false);
  assert.equal(shouldRestartOnEnd('idle'), false);
});

test('recognitionErrorAction: silence keeps listening, real errors fail, post-stop noise is ignored', () => {
  assert.equal(recognitionErrorAction('no-speech', 'listening'), 'restart');
  assert.equal(recognitionErrorAction('speech-timeout', 'listening'), 'restart');
  assert.equal(recognitionErrorAction('not-allowed', 'listening'), 'fail');
  assert.equal(recognitionErrorAction('aborted', 'finishing'), 'ignore');
  // A language switch aborts the recognizer on purpose; the 'end' that follows restarts it.
  assert.equal(recognitionErrorAction('aborted', 'listening'), 'ignore');
  assert.equal(recognitionErrorAction('no-speech', 'idle'), 'ignore');
});

test('recognitionErrorMessage explains permission problems and has a fallback', () => {
  assert.match(recognitionErrorMessage('not-allowed'), /Microphone access/);
  assert.match(recognitionErrorMessage('something-new'), /Try again/);
});

test('slide to cancel: only leftward travel counts, and it cancels at the threshold', () => {
  assert.equal(slideCancelProgress(0), 0);
  assert.equal(slideCancelProgress(40), 0, 'drifting right is nothing');
  assert.equal(slideCancelProgress(-SLIDE_CANCEL_PX / 2), 0.5);
  assert.equal(slideCancelProgress(-SLIDE_CANCEL_PX * 3), 1, 'clamped');
  assert.equal(slideCancelProgress(NaN), 0);
  assert.equal(shouldCancelSlide(-SLIDE_CANCEL_PX + 1), false);
  assert.equal(shouldCancelSlide(-SLIDE_CANCEL_PX), true);
});
