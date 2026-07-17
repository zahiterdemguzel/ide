const { test } = require('node:test');
const assert = require('node:assert');
const { isBulkVcsCommand, tracksFs, editedFilePath, serialFsPlan } = require('../src/main/fs-track');

test('bulk working-tree movers are detected', () => {
  for (const c of [
    'git pull',
    'git pull --ff-only',
    'git merge origin/main',
    'git rebase main',
    'git reset --hard HEAD~1',
    'git stash pop',
    'git cherry-pick abc123',
    'git revert HEAD',
    'git clone https://example.com/x.git',
    'git switch feature',
    'git checkout main',
    'git checkout -b new-feature',
    'git -C /repo pull',
    'git fetch && git merge origin/main', // compound: the merge half counts
  ]) {
    assert.equal(isBulkVcsCommand(c), true, c);
  }
});

test('path-level git edits and unrelated commands are NOT bulk movers', () => {
  for (const c of [
    'git mv old.txt new.txt',
    'git rm file.txt',
    'git add -A',
    'git commit -m "x"',
    'git status',
    'git diff',
    'git checkout -- src/file.js', // pathspec restore, a real working-tree edit
    'git checkout HEAD -- src/file.js',
    'npm install',
    'python build.py',
    'echo "git pull is in a string but not run"'.replace('git pull', 'gitpull'),
    '',
    null,
    undefined,
  ]) {
    assert.equal(isBulkVcsCommand(c), false, String(c));
  }
});

test('fs-touching tools are tracked by the working-tree diff', () => {
  for (const p of [
    { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
    { tool_name: 'Bash', tool_input: { command: 'git mv a.txt b.txt' } },
    { tool_name: 'mcp__server__generate_image', tool_input: {} }, // unknown/MCP tools assumed fs-touching
    { tool_name: 'SomeFutureTool' },
  ]) {
    assert.equal(tracksFs(p), true, p.tool_name);
  }
});

test('text-edit, read-only, subagent-spawning, and bulk-VCS tools are NOT fs-tracked', () => {
  for (const p of [
    { tool_name: 'Write', tool_input: { file_path: 'x' } }, // replayed as text ops
    { tool_name: 'Edit', tool_input: { file_path: 'x' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'x.ipynb' } },
    { tool_name: 'Read' },
    { tool_name: 'Grep' },
    // Both subagent-spawner names: the subagent's own hooks (same session_id)
    // track its file work, so the wrapping call must not pin the counter.
    { tool_name: 'Task', tool_input: { prompt: 'do stuff' } },
    { tool_name: 'Agent', tool_input: { prompt: 'do stuff' } },
    { tool_name: 'Bash', tool_input: { command: 'git pull' } }, // bulk git state move
    {}, // no tool_name at all
  ]) {
    assert.equal(tracksFs(p), false, p.tool_name || '(none)');
  }
});

test('serialFsPlan: snapshot before each tracked tool, diff at its Post', () => {
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' } };
  const post = { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: {} };
  assert.equal(serialFsPlan(pre, false), 'snapshot');
  assert.equal(serialFsPlan(post, true), 'diff');
});

test('serialFsPlan: an orphaned baseline (Post skipped on tool error) is flushed by the next Pre or by Stop', () => {
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'mv a b' } };
  assert.equal(serialFsPlan(pre, true), 'diff-and-snapshot');
  assert.equal(serialFsPlan({ hook_event_name: 'Stop' }, true), 'diff');
});

test('serialFsPlan: no-ops without a baseline or for untracked tools', () => {
  assert.equal(serialFsPlan({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, false), null);
  assert.equal(serialFsPlan({ hook_event_name: 'Stop' }, false), null);
  assert.equal(serialFsPlan({ hook_event_name: 'PreToolUse', tool_name: 'Read' }, false), null);
  assert.equal(serialFsPlan({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git pull' } }, true), null);
  assert.equal(serialFsPlan({ hook_event_name: 'UserPromptSubmit' }, true), null);
});

test('editedFilePath reads file_path and NotebookEdit notebook_path', () => {
  assert.equal(editedFilePath({ file_path: '/repo/a.js' }), '/repo/a.js');
  assert.equal(editedFilePath({ notebook_path: '/repo/n.ipynb' }), '/repo/n.ipynb');
  assert.equal(editedFilePath({}), null);
  assert.equal(editedFilePath(undefined), null);
});
