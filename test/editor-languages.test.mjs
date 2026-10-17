import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageForFile, languageLabel } from '../src/renderer/editor/languages.js';

// A slice of monaco.languages.getLanguages() in its real shape.
const REGISTRY = [
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'], aliases: ['TypeScript', 'ts'] },
  { id: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], aliases: ['JavaScript'] },
  { id: 'python', extensions: ['.py', '.rpy', '.pyw'], aliases: ['Python'] },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'], aliases: ['Dockerfile'] },
  { id: 'php', extensions: ['.php'] },
  { id: 'twig', extensions: ['.twig'], filenamePatterns: ['*.html.twig'] },
  { id: 'html', extensions: ['.html', '.htm'] },
];

test('languageForFile: resolves through the Monaco registry by extension', () => {
  assert.equal(languageForFile('src/app.ts', REGISTRY), 'typescript');
  assert.equal(languageForFile('a/b/c.MJS', REGISTRY), 'javascript');
  assert.equal(languageForFile('tool.py', REGISTRY), 'python');
});

test('languageForFile: exact filenames and filename patterns beat extensions', () => {
  assert.equal(languageForFile('docker/Dockerfile', REGISTRY), 'dockerfile');
  assert.equal(languageForFile('views/page.html.twig', REGISTRY), 'twig');
});

test('languageForFile: overrides cover Godot, TOML and shell dotfiles', () => {
  assert.equal(languageForFile('player.gd', REGISTRY), 'gdscript');
  assert.equal(languageForFile('main.tscn', REGISTRY), 'ini');
  assert.equal(languageForFile('pyproject.toml', REGISTRY), 'ini');
  assert.equal(languageForFile('/home/u/.zshrc', REGISTRY), 'shell');
  assert.equal(languageForFile('.env', REGISTRY), 'ini');
});

test('languageForFile: unknown files are plaintext', () => {
  assert.equal(languageForFile('LICENSE', REGISTRY), 'plaintext');
  assert.equal(languageForFile('data.xyz', REGISTRY), 'plaintext');
  assert.equal(languageForFile('notes.txt'), 'plaintext');
});

test('languageLabel: first alias, else the id', () => {
  assert.equal(languageLabel('typescript', REGISTRY), 'TypeScript');
  assert.equal(languageLabel('php', REGISTRY), 'php');
});
