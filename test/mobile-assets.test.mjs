// The mobile app can't import src/renderer/ (separate Metro root), so the desktop's
// file-icon artwork + extension tables are baked into mobile/src/generated/ by
// scripts/gen-mobile-assets.mjs. That's a copy, and copies rot: this fails the build
// if someone adds an icon or a language mapping and forgets to re-run the generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderModule, OUT_FILE } from '../scripts/gen-mobile-assets.mjs';
import { FILE_ICON_IDS } from '../src/renderer/shared/file-icons.js';

const onDisk = readFileSync(OUT_FILE, 'utf8');

test('mobile/src/generated/desktop-assets.ts is up to date (run: npm run gen:mobile)', () => {
  assert.equal(onDisk, renderModule());
});

test('every icon the desktop mapping can return is bundled for mobile', () => {
  const bundled = new Set([...onDisk.matchAll(/^ {2}"([\w-]+)": "<svg/gm)].map((m) => m[1]));
  for (const id of FILE_ICON_IDS) assert.ok(bundled.has(id), `mobile is missing icon: ${id}`);
});
