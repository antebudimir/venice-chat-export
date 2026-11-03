/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Diagnostics redaction: whitelist-only output, probe assertions. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRedactedDiagnostics, assertNoProbes } from '../lib/redact.js';

const PROBES = [
  '/home/admin/private/venice',
  'C:\\Users\\person\\Documents\\chats',
  'my secret conversation title',
  'conv-abc123def456',
  'secret message body text',
  '0123456789abcdef0123456789abcdef',
];

test('report carries only whitelisted fields', () => {
  const report = buildRedactedDiagnostics({
    schemaVersion: 1,
    extensionVersion: '0.1.0',
    generatedAt: '2026-11-02T00:00:00Z',
    counts: { captures: 2, conversations: 5, messages: 40 },
    sizes: { totalBytes: 1234, avgBytes: 246.8 },
    formats: ['json', 'csv'],
    options: { floatingButton: true, formats: ['json', 'csv'] },
    problems: { failedRuns: 0 },
    conversations: [{ title: PROBES[2] }],
    libraryPath: PROBES[0],
    recordIds: [PROBES[3]],
  });
  const keys = Object.keys(report).sort();
  assert.deepEqual(keys, ['counts', 'extensionVersion', 'formats', 'generatedAt', 'options', 'problems', 'redacted', 'schemaVersion', 'sizes']);
  assert.equal(report.redacted, true);
  assert.equal(report.counts.conversations, 5);
  assert.equal(report.sizes.avgBytes, 246.8);
  assert.equal(report.options.floatingButton, true);
  assert.equal(report.options.formatCount, 2);
});

test('no probe (path, ID, title, text, long hex) ever reaches the report', () => {
  const report = buildRedactedDiagnostics({
    schemaVersion: 1,
    extensionVersion: PROBES[4],
    counts: { captures: 1 },
    sizes: { totalBytes: 10 },
    formats: [PROBES[0], 'json'],
    options: { formats: ['json'] },
    problems: {},
  });
  assertNoProbes(JSON.stringify(report), PROBES);
});

test('non-numeric junk in count slots is dropped, not stringified', () => {
  const report = buildRedactedDiagnostics({ counts: { good: 3, bad: 'lots of text here' } });
  assert.deepEqual(report.counts, { good: 3 });
});

test('assertNoProbes throws when a probe leaks (self-check)', () => {
  const leaking = ['[', PROBES[0]].join('');
  assert.throws(() => assertNoProbes(leaking, PROBES));
  const clean = ['[', ']'].join('');
  assert.doesNotThrow(() => assertNoProbes(clean, PROBES));
});
