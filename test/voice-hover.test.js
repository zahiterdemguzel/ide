const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Voice input finds the session under the mouse cursor by reading
// `data-session-id` off the hovered `.term-container` (src/renderer/voice.js).
// That contract lives in the DOM, so a Node test can't exercise it — but it *can*
// hold the line on the structure that makes it unbreakable.
//
// The original defect: sessions.js created a terminal container in two places and
// only one stamped the attribute, so every session restored from disk was invisible
// to voice input and hovering it did nothing, silently. The fix was to collapse both
// into a single `createTermContainer(id)`. This test guards that collapse — with one
// creation site the invariant is structural, so the interesting property to assert
// is that there is still only one.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const sessionsSrc = read('src', 'renderer', 'sessions.js');
const voiceSrc = read('src', 'renderer', 'voice.js');

test('exactly one place creates a .term-container, and it stamps the session id', () => {
  const sites = sessionsSrc
    .split('\n')
    .filter((line) => /className\s*=\s*['"]term-container['"]/.test(line));

  assert.equal(
    sites.length, 1,
    'a second .term-container creation site means the data-session-id stamp can be '
    + 'forgotten again — build the pane through createTermContainer() instead',
  );
  assert.match(
    sessionsSrc,
    /function createTermContainer\(id\)[\s\S]{0,260}?dataset\.sessionId\s*=\s*id/,
    'createTermContainer must set data-session-id, or voice input cannot resolve '
    + 'which session the cursor is over',
  );
});

test('voice.js still reads the attribute and class that sessions.js writes', () => {
  // The other half of the contract: a rename on the writer side would otherwise
  // break dictation silently, since nothing throws when `closest()` finds nothing.
  assert.match(voiceSrc, /closest\(['"]\.term-container['"]\)/);
  assert.match(voiceSrc, /dataset\.sessionId/);
});
