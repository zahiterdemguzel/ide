import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { iconForFile, iconForFolder, FILE_ICON_IDS } from '../src/renderer/shared/file-icons.js';

const ICON_DIR = new URL('../src/renderer/file-icons/', import.meta.url);
const onDisk = new Set(
  readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4))
);

test('iconForFile: code files map to their language logo', () => {
  assert.equal(iconForFile('app.js'), 'javascript');
  assert.equal(iconForFile('main.ts'), 'typescript');
  assert.equal(iconForFile('view.tsx'), 'react');
  assert.equal(iconForFile('run.py'), 'python');
  assert.equal(iconForFile('lib.rs'), 'rust');
  assert.equal(iconForFile('Main.java'), 'java');
  assert.equal(iconForFile('style.scss'), 'sass');
  assert.equal(iconForFile('README.md'), 'brain'); // markdown shows a brain glyph
});

test('iconForFile: less reuses the css glyph (no standalone less icon)', () => {
  assert.equal(iconForFile('theme.less'), 'css');
});

test('iconForFile: data/asset families map to a shared glyph', () => {
  assert.equal(iconForFile('data.json'), 'json');
  assert.equal(iconForFile('config.yaml'), 'yaml');
  assert.equal(iconForFile('logo.png'), 'image');
  assert.equal(iconForFile('theme.svg'), 'image');
  assert.equal(iconForFile('track.mp3'), 'audio');
  assert.equal(iconForFile('robot.glb'), 'model3d');
  assert.equal(iconForFile('bundle.tar.gz'), 'archive');
  assert.equal(iconForFile('db.sqlite'), 'database');
});

test('iconForFile: case-insensitive on the extension', () => {
  assert.equal(iconForFile('APP.JS'), 'javascript');
  assert.equal(iconForFile('Photo.PNG'), 'image');
});

test('iconForFile: exact filenames win over the extension', () => {
  assert.equal(iconForFile('Dockerfile'), 'docker');
  assert.equal(iconForFile('Makefile'), 'make');
  assert.equal(iconForFile('.gitignore'), 'git');
  assert.equal(iconForFile('package.json'), 'nodejs'); // not the generic json glyph
  assert.equal(iconForFile('package-lock.json'), 'npm');
});

test('iconForFile: accepts a repo-relative path, matches on the basename', () => {
  assert.equal(iconForFile('src/app/main.go'), 'go');
  assert.equal(iconForFile('deep/nested/Dockerfile'), 'docker');
});

test('iconForFile: unknown / extensionless names fall back to the generic file glyph', () => {
  assert.equal(iconForFile('mystery.zzz'), 'file');
  assert.equal(iconForFile('NOTES'), 'file');
});

test('iconForFolder: open vs closed', () => {
  assert.equal(iconForFolder(false), 'folder');
  assert.equal(iconForFolder(true), 'folder-open');
  assert.equal(iconForFolder(), 'folder');
});

test('every icon id the mapping returns has a matching .svg on disk', () => {
  for (const id of FILE_ICON_IDS) assert.ok(onDisk.has(id), `missing icon file: ${id}.svg`);
});

test('every .svg on disk is referenced by the mapping (no orphans)', () => {
  for (const id of onDisk) assert.ok(FILE_ICON_IDS.has(id), `unreferenced icon file: ${id}.svg`);
});
