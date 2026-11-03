/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Export round trips (json/markdown/html), bundle lineage, CSV parser kept
 *  for import even though CSV export was removed in v0.2.0. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeJson, serializeMarkdown, serializeHtml, serializeBundle,
  buildExportEntries, FORMATS,
} from '../lib/serialize.js';
import {
  SUPPORTED_SCHEMA_VERSIONS, detectFormat, parseImport, parseCsv,
} from '../lib/parse.js';

const CONV = {
  id: 'conv-1',
  title: 'Quote test, comma, and <html>',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T11:00:00Z',
  model: 'venice-large',
  messages: [
    { role: 'user', content: 'line one\n\nline two with ```fence``` inside', ts: '2026-11-01T10:00:00Z' },
    { role: 'assistant', content: 'answer, with comma and newline\nsecond line', ts: '2026-11-01T11:00:00Z' },
  ],
};

async function roundTrip(name, serializeFn, parseFn) {
  const text = serializeFn(CONV, { exportedAt: '2026-11-02T00:00:00Z' });
  const result = await parseFn(name, text);
  assert.equal(result.conversations.length, 1, name);
  const c = result.conversations[0];
  assert.equal(c.id, CONV.id);
  assert.equal(c.title, CONV.title);
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].content, CONV.messages[0].content);
  assert.equal(c.messages[1].content, CONV.messages[1].content);
  assert.ok(c.messages.every((m) => /^[0-9a-f]{64}$/.test(m.hash)), 'hashes computed');
  assert.ok(/^[0-9a-f]{64}$/.test(c.contentHash), 'content hash computed');
}

test('FORMATS is the v0.2.0 export set', () => {
  assert.deepEqual(FORMATS, ['json', 'markdown', 'html', 'bundle']);
});

test('format detection: extension first, then sniffing', () => {
  assert.equal(detectFormat('a.json', ''), 'json');
  assert.equal(detectFormat('a.jsonl', ''), 'jsonl');
  assert.equal(detectFormat('a.md', ''), 'markdown');
  assert.equal(detectFormat('a.txt', ''), 'text');
  assert.equal(detectFormat('a.csv', ''), 'csv');
  assert.equal(detectFormat('a.html', ''), 'html');
  assert.equal(detectFormat('unknown-bin', '<!DOCTYPE html><html></html>'), 'html');
  assert.equal(detectFormat('unknown-bin', 'conversation_id,title,role'), 'csv');
  assert.equal(detectFormat('unknown-bin', 'plain words'), 'text');
});

test('CSV parser (import path) handles RFC 4180 quoting', () => {
  const input = ['a,', '1,2,3'].join('\n');
  const withQuotes = 'a,' + String.fromCharCode(34) + 'say ' + String.fromCharCode(34) + String.fromCharCode(34) + 'hi' + String.fromCharCode(34) + String.fromCharCode(34) + String.fromCharCode(34) + ',c';
  const rows = parseCsv(withQuotes + '\n' + input.split('\n')[1] + '\n');
  assert.equal(rows[0][0], 'a');
  assert.equal(rows[0][2], 'c');
  const lf = parseCsv('x,y\n1,2\n');
  assert.deepEqual(lf[0], ['x', 'y']);
  assert.deepEqual(parseCsv('a,"x""y",c\n')[0][1], 'x"y');
});

test('round trip: canonical JSON (backup format)', async () => {
  await roundTrip('export.json', (c) => serializeJson([c]), parseImport);
});

test('round trip: markdown with fenced code preserved', async () => {
  await roundTrip('export.md', (c) => serializeMarkdown(c), parseImport);
  const text = serializeMarkdown(CONV);
  assert.ok(text.includes('## user') && text.includes('## assistant'));
  const tricky = { ...CONV, messages: [{ role: 'user', content: '```js\ncode\n```', ts: null }] };
  const parsed = await parseImport('chat.md', serializeMarkdown(tricky));
  assert.equal(parsed.conversations[0].messages[0].content, '```js\ncode\n```', 'fence escalation preserves code');
});

test('round trip: HTML via embedded payload stays lossless', async () => {
  const text = serializeHtml(CONV);
  assert.ok(text.startsWith('<!DOCTYPE html>'));
  const marker = 'venice-vault-data';
  const start = text.indexOf('id=' + String.fromCharCode(34) + marker + String.fromCharCode(34));
  assert.ok(start !== -1, 'payload node present');
  const jsonStart = text.indexOf('>', start) + 1;
  const jsonEnd = text.indexOf('</script>', jsonStart);
  const payload = JSON.parse(text.slice(jsonStart, jsonEnd).replace(/\\u003c/g, '<'));
  assert.equal(payload.id, CONV.id);
  assert.equal(payload.messages.length, 2);
});

test('bundle export carries conversations plus lineage with occurrences', () => {
  const library = {
    conversations: {
      'conv-1': {
        versions: [{ contentHash: 'x', messageHashes: ['h'], archivedAt: '2026-11-02T00:00:00Z' }],
        occurrences: ['2026-11-03T00:00:00Z', '2026-11-04T00:00:00Z'],
      },
    },
    flagged: [{ id: 'conv-1', kind: 'branch', detectedAt: '2026-11-02T00:00:00Z', contentHash: 'x' }],
  };
  const parsed = JSON.parse(serializeBundle([CONV], library, { exportedAt: '2026-11-02T00:00:00Z' }));
  assert.equal(parsed.bundleVersion, 1);
  assert.equal(parsed.lineage.conversations['conv-1'].versions.length, 1);
  assert.deepEqual(parsed.lineage.conversations['conv-1'].occurrences, library.conversations['conv-1'].occurrences);
  assert.equal(parsed.lineage.flagged.length, 1);
});

test('dispatcher covers every format; removed formats throw', () => {
  const library = { conversations: {}, flagged: [] };
  for (const format of FORMATS) {
    const entries = buildExportEntries(format, [CONV], { exportedAt: '2026-11-02T00:00:00Z', library });
    assert.ok(entries.length >= 1, format);
    assert.ok(entries.every((e) => e.text.length > 0), format);
  }
  assert.equal(buildExportEntries('markdown', [CONV], {}).length, 1, 'one file per conversation');
  for (const removed of ['text', 'jsonl', 'csv', 'pdf']) {
    assert.throws(() => buildExportEntries(removed, [CONV], {}), /unknown export format/, removed);
  }
});

test('unknown schemaVersion is rejected loudly (bundle safety)', async () => {
  const future = JSON.stringify({ schemaVersion: 999, exportedAt: 'x', source: 'venice.ai', conversations: [], lineage: {} });
  await assert.rejects(() => parseImport('future.json', future), (e) => e.code === 'unknown-schema-version' && /999/.test(e.message));
});

test('malformed JSON is rejected with a stable code', async () => {
  await assert.rejects(() => parseImport('bad.json', '{nope'), (e) => e.code === 'malformed-json');
});

test('legacy v0.1.0 export formats still import (text, jsonl, csv)', async () => {
  const legacyText = [
    'Venice.ai transcript',
    'Title: Old chat',
    'Conversation: old-1',
    'Model: unknown',
    'Created: unknown',
    'Updated: unknown',
    '',
    '---',
    '',
    'USER [2026-01-01T00:00:00Z]:',
    'hello from v0.1.0',
    '',
  ].join('\n');
  const fromText = await parseImport('old.txt', legacyText);
  assert.equal(fromText.conversations[0].id, 'old-1');
  assert.equal(fromText.conversations[0].messages[0].content, 'hello from v0.1.0');

  const legacyCsv = 'conversation_id,title,role,timestamp,content\r\nold-2,Old CSV,user,2026-01-01T00:00:00Z,from csv\r\n';
  const fromCsv = await parseImport('old.csv', legacyCsv);
  assert.equal(fromCsv.conversations[0].id, 'old-2');
  assert.equal(fromCsv.conversations[0].messages[0].content, 'from csv');
});

test('SUPPORTED_SCHEMA_VERSIONS is exported for validation UI', () => {
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1]);
});
