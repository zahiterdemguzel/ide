const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRepoName, ghCreateArgs } = require('../src/main/repo-create');

test('validateRepoName: accepts valid names and trims', () => {
  assert.deepEqual(validateRepoName('my-repo'), { ok: true, name: 'my-repo' });
  assert.deepEqual(validateRepoName('  My_Repo.2  '), { ok: true, name: 'My_Repo.2' });
});

test('validateRepoName: rejects empty, dot, and illegal characters', () => {
  assert.equal(validateRepoName('').ok, false);
  assert.equal(validateRepoName('   ').ok, false);
  assert.equal(validateRepoName('.').ok, false);
  assert.equal(validateRepoName('..').ok, false);
  assert.equal(validateRepoName('has space').ok, false);
  assert.equal(validateRepoName('a/b').ok, false);
});

test('ghCreateArgs: private repo with description', () => {
  assert.deepEqual(
    ghCreateArgs({ name: 'thing', description: 'A thing', isPrivate: true }),
    ['repo', 'create', 'thing', '--private', '--description', 'A thing', '--source', '.', '--remote', 'origin', '--push'],
  );
});

test('ghCreateArgs: public repo, blank description omits the flag', () => {
  assert.deepEqual(
    ghCreateArgs({ name: 'thing', description: '   ', isPrivate: false }),
    ['repo', 'create', 'thing', '--public', '--source', '.', '--remote', 'origin', '--push'],
  );
});
