/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pure filename and path utilities for Venice Vault.
 *
 * Cross-platform rules: `/` is the only path separator ever composed here,
 * names are Windows-safe (forbidden characters, reserved device names,
 * trailing dots/spaces, a 120-character cap with a hash suffix), and nothing
 * assumes a home directory, mount point, or drive letter. No browser APIs —
 * this module runs unchanged under Node for the test suite.
 */

const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED_DEVICES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Maximum length of any single filename component after sanitization. */
export const MAX_BASE_LENGTH = 120;
const HASH_SUFFIX_LENGTH = 8;

/** Default export filename template (configurable in options). */
export const DEFAULT_FILENAME_TEMPLATE = 'venice-{date}T{time}-{title}.{ext}';

/**
 * Compute the lowercase hex SHA-256 digest of a string.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`), which is available in browser
 * contexts and in Node >= 19 — the test suite runs this exact function.
 * @param {string} text - Input text, encoded as UTF-8.
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sanitize a single filename component so it is safe on Windows, macOS, and
 * Linux: forbidden characters (`< > : " / \ | ? *`, control chars) become
 * `_`, Windows-reserved device names are prefixed with `_`, trailing dots
 * and spaces are stripped (Windows rules), and names longer than maxLength
 * are truncated with an 8-char hash suffix so collisions stay impossible.
 * @param {string} raw - Unsolicited, user- or site-derived name.
 * @param {{ maxLength?: number }} [options] - Cap override (default 120).
 * @returns {Promise<string>} A safe single-path component.
 */
export async function sanitizeName(raw, options = {}) {
  const maxLength = options.maxLength ?? MAX_BASE_LENGTH;
  let name = String(raw ?? '')
    .replace(FORBIDDEN_CHARS, '_')
    .replace(/[\r\n\t\f\v]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/[. ]+$/g, '');
  if (name === '' || /^\.+$/.test(name)) name = 'untitled';
  const dotIndex = name.indexOf('.');
  const stem = dotIndex === -1 ? name : name.slice(0, dotIndex);
  if (RESERVED_DEVICES.has(stem.toUpperCase())) name = '_' + name;
  if (name.length > maxLength) {
    const suffix = (await sha256Hex(String(raw ?? ''))).slice(0, HASH_SUFFIX_LENGTH);
    name = name.slice(0, maxLength - HASH_SUFFIX_LENGTH - 1) + '-' + suffix;
  }
  return name;
}

/**
 * Local-time slug in the project's canonical run format, e.g.
 * `2026-11-02T14-33-05`. Uses local time deliberately: filenames are for the
 * user, not for machines (ISO instant math stays in the stored metadata).
 * @param {Date} [date] - Defaults to now.
 * @returns {string} `YYYY-MM-DDTHH-mm-ss`.
 */
export function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/**
 * Build a relative export filename from the user's template.
 * Supported tokens: `{date}`, `{time}`, `{title}`, `{ext}`. Unknown tokens
 * are left as literal text. Every path component is sanitized; empty and
 * traversal components (`.`/`..`) are dropped, so the result is always a
 * `/`-separated relative path with no leading or trailing slash.
 * @param {string} template - Filename template from options.
 * @param {{ title?: string, ext?: string, at?: Date }} vars - Token values.
 * @returns {Promise<string>} Relative path such as `venice-2026-11-02T14-33-05-my-chat.json`.
 */
export async function buildFileName(template, vars = {}) {
  const at = vars.at ?? new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  const time = `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
  const title = await sanitizeName(vars.title ?? 'export');
  const ext = (String(vars.ext ?? 'json').replace(/[^a-z0-9]/gi, '').toLowerCase()) || 'json';
  const composed = String(template ?? DEFAULT_FILENAME_TEMPLATE)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{title}', title)
    .replaceAll('{ext}', ext);
  return joinRelative(composed.split('/'));
}

/**
 * Extract the conversation ID from a venice.ai conversation path.
 *
 * Real conversation links are `/chat/classic/<id>`-shaped: a KIND segment
 * followed by the ID, so after the `/chat/` prefix TWO segments are required
 * and the last one is the ID. Nav links (`/chat/agent`, `/chat/classic`) must
 * not match. Other prefixes (`/c/`, `/conversation/`, `/thread/`) accept a
 * single ID segment. IDs are `[A-Za-z0-9_-]{6,}` (observed: 7 chars).
 * @param {string} path - A pathname or full URL.
 * @returns {string|null} The conversation ID, or null for non-conversation paths.
 */
export function conversationIdFromPath(path) {
  const match = String(path ?? '').match(/\/(c|chat|conversation|thread)s?\/([^?#]+)/);
  if (!match) return null;
  const segments = match[2].split('/').filter((segment) => segment !== '');
  const minimumSegments = match[1] === 'chat' ? 2 : 1;
  if (segments.length < minimumSegments) return null;
  const id = segments[segments.length - 1];
  return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
}

/**
 * Join path components into a clean relative `/`-separated path.
 * Drops empty, `.` and `..` components (traversal safety) and sanitizes each
 * remaining component.
 * @param {string[]} parts - Raw components.
 * @returns {Promise<string>} Sanitized relative path.
 */
export async function joinRelative(parts) {
  const clean = [];
  for (const raw of parts ?? []) {
    for (const piece of String(raw ?? '').split('/')) {
      const part = piece.trim();
      if (part === '' || part === '.' || part === '..') continue;
      clean.push(await sanitizeName(part));
    }
  }
  return clean.join('/');
}
