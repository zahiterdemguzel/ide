const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BUILTIN, commandName, commandDescription, mergeCommands } = require('../src/main/slash-commands-lib');

test('commandName: a file under commands/ is named the way the CLI namespaces it', () => {
  assert.equal(commandName('review.md'), '/review');
  assert.equal(commandName('git/sync.md'), '/git:sync');
  assert.equal(commandName('git\\sync.md'), '/git:sync', 'a Windows path names the same command');
});

test('commandDescription: front matter wins, prose is the fallback', () => {
  assert.equal(commandDescription('---\ndescription: Ship it\nmodel: opus\n---\n# Ship\nbody'), 'Ship it');
  assert.equal(commandDescription('---\ndescription: "Quoted"\n---\n'), 'Quoted');
  assert.equal(commandDescription('# Heading\n\nRuns the thing.\n'), 'Runs the thing.');
  assert.equal(commandDescription(''), '');
});

test('mergeCommands: a project command shadows a user one, and both shadow a builtin', () => {
  const merged = mergeCommands(
    BUILTIN,
    [{ name: '/review', description: 'user', source: 'user' }],
    [{ name: '/review', description: 'project', source: 'project' }],
  );
  const review = merged.filter((c) => c.name === '/review');
  assert.equal(review.length, 1);
  assert.equal(review[0].source, 'project');
});

test('mergeCommands: sorted by name, so the menu order is stable', () => {
  const merged = mergeCommands([{ name: '/b' }, { name: '/a' }], [{ name: '/c' }]);
  assert.deepEqual(merged.map((c) => c.name), ['/a', '/b', '/c']);
});
