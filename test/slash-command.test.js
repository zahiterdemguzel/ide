const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STASH_DRAFT, draftSafeSlashCommand } = require('../src/main/slash-command');

test('the draft is stashed before the command is typed, then the command is submitted', () => {
  assert.equal(draftSafeSlashCommand('/effort high'), `${STASH_DRAFT}/effort high\r`);
});

test('the stash key is Ctrl+S', () => {
  assert.equal(STASH_DRAFT.charCodeAt(0), 19);
});
