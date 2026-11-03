/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pure serializers for the Venice Vault export formats. No browser APIs, no
 * DOM. Every function returns a UTF-8 text payload, BOM-less, `\n` endings.
 *
 * Export formats (v0.2.0, each labelled by its job):
 * - json     — backup: canonical, lossless conversations.
 * - bundle   — migration/re-import: everything, including lineage history.
 * - markdown — readable archive, one file per conversation.
 * - html     — self-contained, sanitized archive/printing copy.
 *
 * IMPORT still reads every v0.1.0 format (text, jsonl, csv included) via
 * lib/parse.js — removing export options never orphans existing files.
 */

/** Schema version of the canonical JSON export. */
export const SCHEMA_VERSION = 1;

/** All export formats, in checklist order. */
export const FORMATS = ['json', 'markdown', 'html', 'bundle'];

/**
 * Project a stored conversation to the public export shape, keeping schema
 * placeholders (null) for values the source did not expose.
 * @param {object} conv
 * @returns {object}
 */
function publicConversation(conv) {
  return {
    id: conv.id,
    contentHash: conv.contentHash,
    title: conv.title,
    createdAt: conv.createdAt ?? null,
    updatedAt: conv.updatedAt ?? null,
    model: conv.model ?? null,
    messages: (conv.messages ?? []).map((m) => ({ role: m.role, content: m.content, ts: m.ts ?? null, hash: m.hash })),
  };
}

/**
 * Canonical, lossless JSON backup export.
 * @param {Array<object>} conversations
 * @param {{ exportedAt?: string }} [meta]
 * @returns {string}
 */
export function serializeJson(conversations, meta = {}) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    source: 'venice.ai',
    conversations: (conversations ?? []).map(publicConversation),
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

/** Longest safe code fence for content that itself contains backtick runs. */
function codeFence(content) {
  let n = 3;
  for (const run of String(content ?? '').match(/`{3,}/g) ?? []) n = Math.max(n, run.length + 1);
  return '`'.repeat(n);
}

/** Always-quoted YAML scalar so parser behaviour is predictable. */
function yamlQuoted(value) {
  return '"' + String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t') + '"';
}

/**
 * Markdown export of one conversation: YAML front-matter (title, dates,
 * model, id, hash), `## Role` headings, fenced code preserved verbatim.
 * @param {object} conv
 * @returns {string}
 */
export function serializeMarkdown(conv) {
  const c = publicConversation(conv);
  const out = [
    '---',
    `schemaVersion: ${SCHEMA_VERSION}`,
    `id: ${yamlQuoted(c.id)}`,
    `title: ${yamlQuoted(c.title)}`,
    `createdAt: ${yamlQuoted(c.createdAt)}`,
    `updatedAt: ${yamlQuoted(c.updatedAt)}`,
    `model: ${yamlQuoted(c.model)}`,
    `contentHash: ${yamlQuoted(c.contentHash)}`,
    '---',
    '',
    `# ${c.title}`,
    '',
  ];
  for (const m of c.messages) {
    const fence = codeFence(m.content);
    out.push(`## ${m.role}`, '', fence, m.content ?? '', fence, '');
  }
  return out.join('\n');
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

/** Escape text to HTML paragraphs, converting fenced code blocks to <pre>. */
function contentToHtml(content) {
  const text = String(content ?? '');
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  const parts = [];
  let last = 0;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    if (match.index > last) parts.push(`<p>${escapeHtml(text.slice(last, match.index))}</p>`);
    parts.push(`<pre class=\"vv-code\"><code>${escapeHtml(match[1])}</code></pre>`);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(`<p>${escapeHtml(text.slice(last))}</p>`);
  return parts.join('\n') || '<p></p>';
}

/**
 * Self-contained, sanitized HTML export of one conversation: no external
 * assets, no scripts except the machine-readable JSON payload (which is
 * `<`-escaped and therefore cannot close its own tag or inject markup).
 * @param {object} conv
 * @returns {string}
 */
export function serializeHtml(conv) {
  const c = publicConversation(conv);
  const payload = JSON.stringify(c)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const out = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(c.title)}</title>`,
    '<style>',
    'body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#faf7f4;color:#241d18}',
    '.vv-wrap{max-width:52rem;margin:0 auto;padding:2rem}',
    'h1{font-size:1.4rem}',
    '.vv-meta{color:#6b5f55;font-size:.85rem;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.vv-msg{background:#fff;border:1px solid #e2d9d2;border-radius:8px;padding:1rem;margin:1rem 0}',
    '.vv-role{font-weight:600;text-transform:uppercase;font-size:.75rem;color:#9a3412}',
    '.vv-ts{color:#6b5f55;font-size:.75rem;font-family:ui-monospace,monospace}',
    '.vv-content{white-space:pre-wrap;overflow-wrap:anywhere}',
    'pre.vv-code{background:#171412;color:#f2ece6;padding:1rem;border-radius:8px;overflow:auto}',
    '@media print{.vv-msg{border-color:#c6b8ac}}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="vv-wrap">',
    `<h1>${escapeHtml(c.title)}</h1>`,
    `<p class="vv-meta">${escapeHtml(`id: ${c.id} · model: ${c.model ?? 'unknown'} · created: ${c.createdAt ?? 'unknown'} · updated: ${c.updatedAt ?? 'unknown'} · hash: ${c.contentHash}`)}</p>`,
  ];
  for (const m of c.messages) {
    out.push(`<article class="vv-msg"><header><span class="vv-role">${escapeHtml(m.role)}</span> <span class="vv-ts">${escapeHtml(m.ts ?? '')}</span></header><div class="vv-content">${contentToHtml(m.content)}</div></article>`);
  }
  out.push('</div>', `<script type="application/json" id="venice-vault-data">${payload}</script>`, '</body>', '</html>', '');
  return out.join('\n');
}

/**
 * Combined bundle export: conversations PLUS full lineage history (versions,
 * occurrences, flagged conflicts) in one JSON file for one-shot migration.
 * This is the format to export before an OS reinstall.
 * @param {Array<object>} conversations
 * @param {{ conversations?: Record<string, object>, flagged?: Array }} [library]
 * @param {{ exportedAt?: string }} [meta]
 * @returns {string}
 */
export function serializeBundle(conversations, library, meta = {}) {
  const lineageOut = {};
  for (const [id, record] of Object.entries(library?.conversations ?? {})) {
    lineageOut[id] = {
      occurrences: [...(record.occurrences ?? [])],
      versions: (record.versions ?? []).map((v) => ({
        contentHash: v.contentHash,
        messageHashes: v.messageHashes,
        archivedAt: v.archivedAt,
      })),
    };
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    bundleVersion: 1,
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    source: 'venice.ai',
    conversations: (conversations ?? []).map(publicConversation),
    lineage: { conversations: lineageOut, flagged: library?.flagged ?? [] },
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

/**
 * Build the export entries for one format. Markdown/HTML produce one entry
 * per conversation; json/bundle produce a single entry.
 * @param {'json'|'markdown'|'html'|'bundle'} format
 * @param {Array<object>} conversations
 * @param {{ exportedAt?: string, runTitle?: string, library?: object }} [meta]
 * @returns {Array<{ title: string, ext: string, text: string }>}
 */
export function buildExportEntries(format, conversations, meta = {}) {
  const metaFull = { exportedAt: meta.exportedAt ?? new Date().toISOString(), library: meta.library };
  const runTitle = meta.runTitle ?? 'export';
  switch (format) {
    case 'json':
      return [{ title: runTitle, ext: 'json', text: serializeJson(conversations, metaFull) }];
    case 'bundle':
      return [{ title: runTitle, ext: 'json', text: serializeBundle(conversations, metaFull.library, metaFull) }];
    case 'markdown':
      return (conversations ?? []).map((c) => ({ title: c.title || c.id || 'conversation', ext: 'md', text: serializeMarkdown(c) }));
    case 'html':
      return (conversations ?? []).map((c) => ({ title: c.title || c.id || 'conversation', ext: 'html', text: serializeHtml(c) }));
    default:
      throw new Error(`unknown export format: ${format}`);
  }
}
