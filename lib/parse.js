/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Pure import parsers and format detection for Venice Chat Export. No DOM, no
 * browser APIs. HTML import needs DOMParser and lives in lib/html.js so this
 * module stays pure and fully testable.
 *
 * Detection is extension-first, content-sniffing second. Schema versions
 * other than the supported set are rejected with a clear error.
 */

import {
  conversationContentHashFromHashes,
  hashConversationMessages,
} from './lineage.js';

/** Schema versions this build can import. */
export const SUPPORTED_SCHEMA_VERSIONS = [1];

const KNOWN_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/** Error with a stable machine code (UI maps it to localized text). */
function parseError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Detect the import format of a file.
 * @param {string} fileName - Original file name (extension checked first).
 * @param {string} text - File contents.
 * @returns {'json'|'jsonl'|'markdown'|'text'|'csv'|'html'}
 */
export function detectFormat(fileName, text) {
  const ext = (String(fileName ?? '').match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const byExt = {
    json: 'json', jsonl: 'jsonl', md: 'markdown', markdown: 'markdown',
    txt: 'text', csv: 'csv', html: 'html', htm: 'html',
  }[ext];
  if (byExt) return byExt;
  const head = String(text ?? '').slice(0, 2048).trimStart().toLowerCase();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('---')) return 'markdown';
  if (head.startsWith('conversation_id,')) return 'csv';
  const jsonLines = head.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  if (jsonLines.length >= 2) return 'jsonl';
  return 'text';
}

/**
 * RFC 4180 CSV parser: handles quoted fields, escaped quotes (`""`), and
 * embedded CRLF. Accepts LF-only input as well.
 * @param {string} text
 * @returns {string[][]} Rows of raw fields (no header interpretation).
 */
export function parseCsv(text) {
  const s = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Undo serialize.js's always-quoted YAML style. */
function unquoteYaml(value) {
  const v = String(value ?? '').trim();
  if (/^".*"$/s.test(v)) {
    return v.slice(1, -1)
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  return v;
}

function parseFrontMatter(text) {
  const match = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = unquoteYaml(kv[2]);
  }
  return { meta, body: String(text).slice(match[0].length) };
}

/**
 * Parse one of our Markdown exports back into a raw conversation.
 * @param {string} text
 * @returns {object} Raw conversation (id/title/messages without hashes).
 */
export function parseMarkdownImport(text) {
  const fm = parseFrontMatter(text);
  if (!fm) throw parseError('malformed-markdown', 'missing YAML front matter');
  const sections = fm.body.split(/^##\s+(.+?)\s*$/m);
  const messages = [];
  for (let i = 1; i < sections.length; i += 2) {
    const role = sections[i].trim().toLowerCase();
    const body = (sections[i + 1] ?? '').trim();
    const fence = body.match(/^(`{3,})\n([\s\S]*?)\n\1\s*$/);
    messages.push({ role, content: fence ? fence[2] : body, ts: null });
  }
  return {
    id: fm.meta.id || null,
    title: fm.meta.title || 'Untitled',
    createdAt: fm.meta.createdAt || null,
    updatedAt: fm.meta.updatedAt || null,
    model: fm.meta.model || null,
    messages,
  };
}

/**
 * Parse one of our plain-text transcript exports.
 * @param {string} text
 * @returns {object} Raw conversation.
 */
export function parseTextImport(text) {
  const raw = { id: null, title: 'Untitled', createdAt: null, updatedAt: null, model: null, messages: [] };
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^Title: (.*)$/))) raw.title = m[1];
    else if ((m = line.match(/^Conversation: (.*)$/))) raw.id = m[1];
    else if ((m = line.match(/^Model: (.*)$/))) raw.model = m[1] === 'unknown' ? null : m[1];
    else if ((m = line.match(/^Created: (.*)$/))) raw.createdAt = m[1] === 'unknown' ? null : m[1];
    else if ((m = line.match(/^Updated: (.*)$/))) raw.updatedAt = m[1] === 'unknown' ? null : m[1];
    else if ((m = line.match(/^([A-Za-z]+) \[([^\]]*)\]:$/))) {
      current = { role: m[1].toLowerCase(), ts: m[2] === 'no timestamp' ? null : m[2], content: [] };
      raw.messages.push(current);
    } else if (current && line !== '---') {
      current.content.push(line);
    }
  }
  raw.messages = raw.messages.map((m) => ({ role: m.role, ts: m.ts, content: m.content.join('\n').replace(/\n$/, '') }));
  if (raw.messages.length === 0) throw parseError('malformed-text', 'no ROLE [timestamp]: blocks found');
  return raw;
}

/** Validate and split a canonical JSON export. */
function parseJsonExport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch (e) {
    throw parseError('malformed-json', `invalid JSON: ${e.message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw parseError('malformed-json', 'expected an object with schemaVersion and conversations');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(data.schemaVersion)) {
    throw parseError('unknown-schema-version', `unsupported schemaVersion: ${JSON.stringify(data.schemaVersion ?? null)}`);
  }
  if (!Array.isArray(data.conversations)) throw parseError('malformed-json', 'missing conversations array');
  return data.conversations;
}

/** Validate and split a JSONL export (header line + one conversation per line). */
function parseJsonlExport(text) {
  const conversations = [];
  let sawHeader = false;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      throw parseError('malformed-json', `invalid JSONL line: ${e.message}`);
    }
    if (entry.type === 'venice-chat-export-jsonl') {
      if (!SUPPORTED_SCHEMA_VERSIONS.includes(entry.schemaVersion)) {
        throw parseError('unknown-schema-version', `unsupported schemaVersion: ${JSON.stringify(entry.schemaVersion ?? null)}`);
      }
      sawHeader = true;
      continue;
    }
    if (Array.isArray(entry.messages)) conversations.push(entry);
  }
  if (!sawHeader) throw parseError('unknown-schema-version', 'JSONL file has no venice-chat-export header line');
  return conversations;
}

/** Group CSV rows (our own header) into raw conversations. */
function parseCsvImport(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw parseError('malformed-csv', 'empty CSV');
  const header = rows[0].map((h) => h.trim());
  const wanted = ['conversation_id', 'title', 'role', 'timestamp', 'content'];
  const idx = {};
  for (const name of wanted) {
    const at = header.indexOf(name);
    if (at === -1) throw parseError('malformed-csv', `missing column: ${name}`);
    idx[name] = at;
  }
  const byId = new Map();
  for (const row of rows.slice(1)) {
    const id = row[idx.conversation_id] ?? '';
    if (id === '') continue;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: row[idx.title] || 'Untitled',
        createdAt: null, updatedAt: null, model: null, messages: [],
      });
    }
    byId.get(id).messages.push({
      role: row[idx.role] || 'unknown',
      content: row[idx.content] ?? '',
      ts: row[idx.timestamp] || null,
    });
  }
  return Array.from(byId.values());
}

/**
 * Normalize a raw conversation into the canonical internal shape, computing
 * message hashes and the content hash. Unknown roles become `unknown` with a
 * warning; missing IDs are derived from the content hash.
 * @param {object} raw
 * @param {Array<{ code: string, detail?: string }>} warnings - Appended to.
 * @returns {Promise<object>} Canonical conversation with hashes.
 */
export async function normalizeConversation(raw, warnings) {
  const messages = [];
  for (const m of raw.messages ?? []) {
    const role = String(m.role ?? 'unknown').toLowerCase();
    if (!KNOWN_ROLES.has(role)) warnings.push({ code: 'unknown-role', detail: role });
    messages.push({ role: KNOWN_ROLES.has(role) ? role : 'unknown', content: String(m.content ?? ''), ts: m.ts ?? null });
  }
  const messageHashes = await hashConversationMessages(messages);
  const contentHash = await conversationContentHashFromHashes(messageHashes);
  let id = raw.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : null;
  if (!id) {
    id = `derived-${contentHash.slice(0, 16)}`;
    warnings.push({ code: 'missing-id', detail: id });
  }
  return {
    id,
    contentHash,
    title: String(raw.title ?? 'Untitled'),
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    model: raw.model ?? null,
    messages: messages.map((m, i) => ({ ...m, hash: messageHashes[i] })),
  };
}

/**
 * Parse one import file (anything except HTML — route that through
 * lib/html.js first, then feed its JSON payload back here as `json`).
 * @param {string} fileName
 * @param {string} text
 * @returns {Promise<{ format: string, conversations: Array<object>, warnings: Array<{ code: string, detail?: string }> }>}
 * @throws {Error} With a `code` property: unsupported-format,
 * unknown-schema-version, malformed-json, malformed-markdown, malformed-text,
 * malformed-csv, no-conversations.
 */
export async function parseImport(fileName, text) {
  const warnings = [];
  const format = detectFormat(fileName, text);
  let rawConversations;
  switch (format) {
    case 'json': rawConversations = parseJsonExport(text); break;
    case 'jsonl': rawConversations = parseJsonlExport(text); break;
    case 'markdown': rawConversations = [parseMarkdownImport(text)]; break;
    case 'text': rawConversations = [parseTextImport(text)]; break;
    case 'csv': rawConversations = parseCsvImport(text); break;
    case 'html': throw parseError('html-requires-dom', 'HTML import must be routed through lib/html.js');
    default: throw parseError('unsupported-format', `cannot determine format of ${fileName}`);
  }
  const conversations = [];
  for (const raw of rawConversations) conversations.push(await normalizeConversation(raw, warnings));
  if (conversations.length === 0) throw parseError('no-conversations', 'no conversations found');
  return { format, conversations, warnings };
}
