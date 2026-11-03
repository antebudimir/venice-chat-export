/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Dev-only post-build step: web-ext names its output after the manifest
 * `name`, but Firefox's file picker and about:debugging look for the .xpi
 * extension. Renames the freshest .zip in web-ext-artifacts/ to .xpi.
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'web-ext-artifacts');
const zips = fs.readdirSync(dir).filter((f) => f.endsWith('.zip'));
if (zips.length === 0) {
  console.error('no .zip found in web-ext-artifacts/');
  process.exit(1);
}
// Freshest by mtime, so stale artifacts are never renamed instead.
const freshest = zips
  .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0].f;
const target = path.join(dir, freshest.replace(/\.zip$/, '.xpi'));
fs.renameSync(path.join(dir, freshest), target);
// Remove any other stale zip/xpi so the artifacts dir holds exactly one file.
for (const f of fs.readdirSync(dir)) {
  if (f !== path.basename(target)) fs.rmSync(path.join(dir, f));
}
console.log('renamed to', path.basename(target));
