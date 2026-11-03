// The phone's pre-create CLI check (mobile/src/lib/cli-check.js): which CLI a model
// runs on, and what to tell the user when it's missing on the desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliForModel, cliCheckChannel, cliProblem } from '../mobile/src/lib/cli-check.js';

test('cliForModel maps codex ids to codex and everything else to claude', () => {
  assert.equal(cliForModel('codex:gpt-5.5'), 'codex');
  assert.equal(cliForModel('default'), 'claude');
  assert.equal(cliForModel('opus'), 'claude');
  // Ollama models run through the Claude CLI via the local proxy.
  assert.equal(cliForModel('ollama:llama3'), 'claude');
  assert.equal(cliForModel(null), 'claude');
  assert.equal(cliForModel(undefined), 'claude');
});

test('cliCheckChannel picks the matching desktop probe', () => {
  assert.equal(cliCheckChannel('codex:gpt-5.4'), 'check-codex');
  assert.equal(cliCheckChannel('sonnet'), 'check-claude');
});

test('cliProblem is null when the CLI is usable or the check gave no answer', () => {
  assert.equal(cliProblem('claude', { installed: true, version: '2.0.0' }), null);
  assert.equal(cliProblem('codex', { installed: true, loggedIn: true }), null);
  assert.equal(cliProblem('claude', null), null);
  assert.equal(cliProblem('codex', undefined), null);
});

test('cliProblem explains a missing Claude CLI, with the install guide link', () => {
  const p = cliProblem('claude', { installed: false, guide: { docsUrl: 'https://docs.example/install' } });
  assert.equal(p.title, 'Claude Code not installed');
  assert.match(p.message, /https:\/\/docs\.example\/install/);
});

test('cliProblem explains a missing or signed-out Codex CLI', () => {
  assert.equal(cliProblem('codex', { installed: false, loggedIn: false }).title, 'Codex CLI not installed');
  assert.equal(cliProblem('codex', { installed: true, loggedIn: false }).title, 'Codex CLI not signed in');
});
