/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * DOMParser-dependent import support for .html exports.
 *
 * This module exists specifically to keep DOMParser OUT of lib/parse.js, so
 * parse.js stays pure and testable under Node without mocks. It is therefore
 * not exercised by the Node test suite.
 *
 * Our HTML exports embed the canonical conversation JSON in a
 * <script type="application/json" id="venice-chat-export-data"> node (with `<`
 * escaped), so the primary path is lossless. The fallback reads the rendered
 * markup for files produced by other tools or older versions.
 */

/**
 * Extract importable data from an HTML document.
 * @param {string} htmlText - Raw HTML file contents.
 * @returns {{ jsonText: string|null, conversations: Array<object>|null }}
 *   `jsonText` is the embedded canonical JSON (feed to parse.js as JSON);
 *   `conversations` is raw conversation data reconstructed from the markup.
 *   Exactly one of the two is non-null for a valid export; both null when
 *   nothing recognizable is present.
 */
export function extractHtmlPayload(htmlText) {
  const doc = new DOMParser().parseFromString(String(htmlText ?? ''), 'text/html');

  const embedded = doc.getElementById('venice-chat-export-data');
  if (embedded?.textContent) {
    return { jsonText: embedded.textContent, conversations: null };
  }

  const title = doc.querySelector('.vv-wrap > h1')?.textContent?.trim() ?? 'Untitled';
  const messages = [];
  for (const article of doc.querySelectorAll('.vv-msg')) {
    const role = article.querySelector('.vv-role')?.textContent?.trim().toLowerCase() ?? 'unknown';
    const ts = article.querySelector('.vv-ts')?.textContent?.trim() || null;
    const content = article.querySelector('.vv-content')?.textContent ?? '';
    messages.push({ role, content, ts });
  }
  if (messages.length === 0) return { jsonText: null, conversations: null };
  return { jsonText: null, conversations: [{ title, messages }] };
}
