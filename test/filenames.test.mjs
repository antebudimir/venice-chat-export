/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Windows-rule sanitizer, hash-suffix cap, template, path joining. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sha256Hex,
  sanitizeName,
  timestampSlug,
  buildFileName,
  joinRelative,
  conversationIdFromPath,
  DEFAULT_FILENAME_TEMPLATE,
  MAX_BASE_LENGTH,
} from '../lib/filenames.js';

test('sha256Hex matches the known digest of the empty string', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex is stable across calls', async () => {
  assert.equal(await sha256Hex('venice'), await sha256Hex('venice'));
  assert.notEqual(await sha256Hex('venice'), await sha256Hex('Venice'));
});

test('sanitizeName replaces Windows-forbidden characters', async () => {
  assert.equal(await sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(await sanitizeName('ctrl\u0007char'), 'ctrl_char');
});

test('sanitizeName strips trailing dots and spaces (Windows rules)', async () => {
  assert.equal(await sanitizeName('name... '), 'name');
  assert.equal(await sanitizeName('name.'), 'name');
});

test('sanitizeName prefixes Windows-reserved device names', async () => {
  assert.equal(await sanitizeName('CON'), '_CON');
  assert.equal(await sanitizeName('com1.log'), '_com1.log');
  assert.equal(await sanitizeName('notes'), 'notes');
});

test('sanitizeName handles empty and dot-only names', async () => {
  assert.equal(await sanitizeName(''), 'untitled');
  assert.equal(await sanitizeName('...'), 'untitled');
  assert.equal(await sanitizeName(null), 'untitled');
});

test('sanitizeName caps length with an 8-char hash suffix', async () => {
  const long = 'x'.repeat(400);
  const name = await sanitizeName(long);
  assert.ok(name.length <= MAX_BASE_LENGTH, `length ${name.length}`);
  assert.match(name, /-[0-9a-f]{8}$/);
  const other = await sanitizeName(long + 'y');
  assert.notEqual(name, other, 'different inputs must hash to different suffixes');
});

test('timestampSlug uses the canonical run format', () => {
  assert.equal(timestampSlug(new Date(2026, 10, 2, 14, 33, 5)), '2026-11-02T14-33-05');
});

test('buildFileName substitutes every token and stays Windows-safe', async () => {
  const name = await buildFileName(DEFAULT_FILENAME_TEMPLATE, {
    title: 'My Chat: "final"?',
    ext: 'json',
    at: new Date(2026, 10, 2, 14, 33, 5),
  });
  assert.equal(name, 'venice-2026-11-02T14-33-05-My Chat_ _final__.json');
});

test('buildFileName drops traversal components', async () => {
  const name = await buildFileName('../../{title}/{ext}', { title: 'safe', ext: 'md', at: new Date(2026, 0, 1) });
  assert.ok(!name.includes('..'), name);
  assert.ok(!name.startsWith('/'), name);
});

test('joinRelative sanitizes and normalizes', async () => {
  assert.equal(await joinRelative(['', '.', '..', 'a', 'b//c']), 'a/b/c');
});

test('conversationIdFromPath: real Venice sidebar conversation links', () => {
  assert.equal(conversationIdFromPath('/chat/classic/AdMBKI5'), 'AdMBKI5');
  assert.equal(conversationIdFromPath('https://venice.ai/chat/classic/wT1LZBb'), 'wT1LZBb');
  assert.equal(conversationIdFromPath('/chat/classic/kpeILH1?utm=x'), 'kpeILH1');
  assert.equal(conversationIdFromPath('/chat/classic/uElkhNv/'), 'uElkhNv');
});

test('conversationIdFromPath: rejects nav links and prefix-only paths', () => {
  assert.equal(conversationIdFromPath('/chat/classic'), null, 'Classic Chat nav link');
  assert.equal(conversationIdFromPath('/chat/agent'), null, 'Agentic Chat nav link');
  assert.equal(conversationIdFromPath('/chat'), null);
  assert.equal(conversationIdFromPath('/chat/'), null);
  assert.equal(conversationIdFromPath('/studio'), null);
  assert.equal(conversationIdFromPath('/discover'), null);
  assert.equal(conversationIdFromPath('/minds'), null);
});

test('conversationIdFromPath: single-segment forms for non-chat prefixes', () => {
  assert.equal(conversationIdFromPath('/c/abc123'), 'abc123');
  assert.equal(conversationIdFromPath('/conversation/AbCdEf9'), 'AbCdEf9');
  assert.equal(conversationIdFromPath('/thread/xyz6789'), 'xyz6789');
});
