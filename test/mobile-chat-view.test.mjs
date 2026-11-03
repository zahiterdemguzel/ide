// The chat screen's pure decisions (mobile/src/lib/chat-view.js): attachment paths,
// the diff preview cap, ask readiness, and what a merge result says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAttachments, capLines, moreLinesLabel, isAnswered, allAnswered,
  mergeOutcome, conflictPrompt, worktreeMode, DIFF_PAGE_LINES,
} from '../mobile/src/lib/chat-view.js';

test('splitAttachments pulls image path lines out of the text', () => {
  const r = splitAttachments('look at this\n/tmp/ide-chat-attachments/1-a.jpg\n"C:\\Temp\\b.PNG"');
  assert.equal(r.said, 'look at this');
  assert.equal(r.files, 2);
  assert.deepEqual(r.paths, ['/tmp/ide-chat-attachments/1-a.jpg', 'C:\\Temp\\b.PNG']);
});

test('splitAttachments leaves prose and non-image paths alone', () => {
  const r = splitAttachments('edit /src/app.ts please\n/src/app.ts');
  assert.equal(r.files, 0);
  assert.deepEqual(r.paths, []);
  assert.equal(r.said, 'edit /src/app.ts please\n/src/app.ts');
  assert.deepEqual(splitAttachments(''), { said: '', files: 0, paths: [] });
});

test('capLines keeps short lists whole and reports what it hid', () => {
  assert.deepEqual(capLines([1, 2], 5), { shown: [1, 2], hidden: 0 });
  assert.deepEqual(capLines([1, 2, 3, 4], 3), { shown: [1, 2, 3], hidden: 1 });
  assert.deepEqual(capLines(undefined, 3), { shown: [], hidden: 0 });
});

test('moreLinesLabel says "all" only when the next page reaches the end', () => {
  assert.equal(moreLinesLabel(10, 90), 'Show all 90 lines');
  assert.equal(moreLinesLabel(DIFF_PAGE_LINES, 500), 'Show all 500 lines');
  assert.equal(moreLinesLabel(1000, 1080), `Show ${DIFF_PAGE_LINES} more lines (1000 hidden)`);
});

test('an ask is ready only when every question has an answer', () => {
  assert.equal(isAnswered(undefined), false);
  assert.equal(isAnswered({ keys: [] }), false);
  assert.equal(isAnswered({ key: '1' }), true);
  assert.equal(isAnswered({ text: 'no' }), true);
  assert.equal(allAnswered(1, []), false);
  assert.equal(allAnswered(1, [{ key: '2' }]), true);
  assert.equal(allAnswered(2, [{ key: '2' }]), false);
  assert.equal(allAnswered(2, [{ key: '2' }, { keys: ['1', '3'] }]), true);
  assert.equal(allAnswered(0, []), false);
});

test('mergeOutcome maps each reply shape to what the reader sees', () => {
  assert.deepEqual(mergeOutcome({ ok: true, branch: 'b', base: 'main' }), { kind: 'merged', message: 'Merged into main' });
  assert.equal(mergeOutcome({ ok: true, noop: true }).kind, 'noop');
  assert.equal(mergeOutcome({ ok: false, needsMerge: true, stderr: 'CONFLICT' }).kind, 'conflict');
  assert.match(mergeOutcome({ ok: false, code: 'dirty-main' }).message, /uncommitted changes/);
  assert.deepEqual(mergeOutcome({ ok: false, stderr: 'boom' }), { kind: 'failed', message: 'boom' });
  assert.deepEqual(mergeOutcome(null), { kind: 'failed', message: 'Merge failed' });
});

test('conflictPrompt names both branches and carries git output', () => {
  const p = conflictPrompt({ base: 'main', branch: 'sess/x', stderr: 'CONFLICT in a.js' });
  assert.match(p, /Merge branch main into sess\/x/);
  assert.match(p, /CONFLICT in a\.js$/);
});

test('worktreeMode distinguishes ordinary, ready, missing and pending sessions', () => {
  assert.equal(worktreeMode(null), '');
  assert.equal(worktreeMode({ worktree: '' }), '');
  assert.equal(worktreeMode({ worktree: '/w', worktreeState: 'ready' }), 'ready');
  assert.equal(worktreeMode({ worktree: '/w', worktreeState: 'missing' }), 'missing');
  assert.equal(worktreeMode({ worktree: '/w', worktreeState: 'creating' }), 'pending');
});
