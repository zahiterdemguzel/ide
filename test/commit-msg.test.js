const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commitMessagePrompt, cleanCommitMessage, fallbackCommitMessage } = require('../src/main/commit-msg');

test('commitMessagePrompt: embeds the diff and caps its length', () => {
  const p = commitMessagePrompt('diff --git a/x b/x\n+hello', 12000);
  assert.match(p, /imperative subject line/);
  assert.match(p, /\+hello/);
  const big = 'x'.repeat(20000);
  const capped = commitMessagePrompt(big, 12000);
  assert.equal(capped.includes('x'.repeat(12000)), true);
  assert.equal(capped.includes('x'.repeat(12001)), false);
});

test('commitMessagePrompt: tolerates an empty/undefined diff', () => {
  assert.equal(typeof commitMessagePrompt(undefined), 'string');
  assert.equal(typeof commitMessagePrompt(''), 'string');
});

test('cleanCommitMessage: trims and passes a plain message through', () => {
  assert.equal(cleanCommitMessage('  Add the thing\n\nBody line  '), 'Add the thing\n\nBody line');
});

test('cleanCommitMessage: strips a ``` fence', () => {
  assert.equal(cleanCommitMessage('```\nFix the bug\n```'), 'Fix the bug');
  assert.equal(cleanCommitMessage('```text\nFix the bug\n```'), 'Fix the bug');
});

test('cleanCommitMessage: strips matching wrapping quotes', () => {
  assert.equal(cleanCommitMessage('"Add a feature"'), 'Add a feature');
  assert.equal(cleanCommitMessage("'Add a feature'"), 'Add a feature');
  assert.equal(cleanCommitMessage('`Add a feature`'), 'Add a feature');
  // A leading-only quote (apostrophe in body) is left intact.
  assert.equal(cleanCommitMessage("Don't change this"), "Don't change this");
});

test('cleanCommitMessage: empty reply returns empty string', () => {
  assert.equal(cleanCommitMessage(''), '');
  assert.equal(cleanCommitMessage('   \n  '), '');
  assert.equal(cleanCommitMessage(null), '');
});

test('cleanCommitMessage: caps the length', () => {
  assert.equal(cleanCommitMessage('a'.repeat(2000), 1000).length, 1000);
});

test('fallbackCommitMessage: prefers the session name (title)', () => {
  assert.equal(fallbackCommitMessage({ name: 'Add git panel', firstPrompt: 'please make the git panel nicer', id: 'abcd1234ef' }), 'Add git panel');
});

test('fallbackCommitMessage: falls back to the first prompt line, then the id stub', () => {
  assert.equal(fallbackCommitMessage({ name: '', firstPrompt: 'fix the bug\nmore detail', id: 'abcd1234ef' }), 'fix the bug');
  assert.equal(fallbackCommitMessage({ name: '', firstPrompt: '', id: 'abcd1234ef' }), 'session abcd1234');
});

test('fallbackCommitMessage: caps the length', () => {
  assert.equal(fallbackCommitMessage({ name: 'n'.repeat(800) }, 500).length, 500);
});
