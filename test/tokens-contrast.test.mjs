/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Contrast gate: parses ui/tokens.css (the single source of tokens, linked
 * first by popup and options) and enforces WCAG ratios in BOTH themes:
 * text pairs >= 4.5:1, UI component boundary (--border-strong) >= 3:1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'ui', 'tokens.css'), 'utf8');

function parseTheme(text) {
  const tokens = {};
  const re = /--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match;
  while ((match = re.exec(text)) !== null) tokens[match[1]] = match[2];
  return tokens;
}

function themeBlock(name) {
  const marker = name === 'dark'
    ? ':root {'
    : '@media (prefers-color-scheme: light) {';
  const start = css.indexOf(marker);
  assert.ok(start !== -1, `theme block ${name} found`);
  const nextBrace = css.indexOf('{', start + marker.length);
  const rest = name === 'dark' ? css : css.slice(nextBrace);
  const block = name === 'dark'
    ? css.slice(start, css.indexOf('}', start))
    : rest.slice(0, rest.indexOf('\n}'));
  return parseTheme(block);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const theme of ['dark', 'light']) {
  test(`${theme} theme: text tokens >= 4.5:1 on surface`, () => {
    const tokens = themeBlock(theme);
    assert.ok(contrast(tokens.text, tokens.surface) >= 4.5);
    assert.ok(contrast(tokens['text-muted'], tokens.surface) >= 4.5);
    assert.ok(contrast(tokens.danger, tokens.surface) >= 4.5);
  });

  test(`${theme} theme: primary button label >= 4.5:1 at rest and on hover`, () => {
    const tokens = themeBlock(theme);
    assert.ok(contrast('#ffffff', tokens.accent) >= 4.5);
    assert.ok(contrast('#ffffff', tokens['accent-strong']) >= 4.5);
    assert.ok(contrast('#ffffff', tokens['danger-strong']) >= 4.5);
  });

  test(`${theme} theme: accent and strong borders >= 3:1 on surface (UI)`, () => {
    const tokens = themeBlock(theme);
    assert.ok(contrast(tokens.accent, tokens.surface) >= 3, `accent ${contrast(tokens.accent, tokens.surface)}`);
    assert.ok(contrast(tokens['border-strong'], tokens.surface) >= 3, `border-strong ${contrast(tokens['border-strong'], tokens.surface)}`);
  });
}

test('both themes define the complete token set', () => {
  const required = ['surface', 'surface-raised', 'border', 'border-strong', 'text', 'text-muted', 'accent', 'accent-hover', 'accent-strong', 'accent-muted', 'danger', 'danger-strong'];
  for (const theme of ['dark', 'light']) {
    const tokens = themeBlock(theme);
    for (const key of required) assert.ok(tokens[key], `${theme}/${key}`);
  }
});
