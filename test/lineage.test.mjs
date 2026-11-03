/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Lineage classification table, canonical JSON, merge plan semantics. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  hashMessage,
  hashConversationMessages,
  conversationContentHashFromHashes,
  sharedPrefixLength,
  classifyHashes,
  buildMergePlan,
  applyPlan,
  emptyLibrary,
  mergeBundleLineage,
  KINDS,
} from '../lib/lineage.js';

const msg = async (role, content, ts = null) => hashMessage({ role, content, ts });
const hashes = async (...specs) => Promise.all(specs.map(([r, c, ts]) => msg(r, c, ts)));

test('canonicalJson is key-order independent and whitespace-free', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: { d: 4, c: [3, { f: 6, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":6}],"d":4}}');
  assert.ok(!canonicalJson({ a: 1 }).includes(' '));
});

test('canonicalJson drops undefined but keeps null', () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test('message hash is content-based and order-relevant', async () => {
  assert.equal(await msg('user', 'hi'), await msg('user', 'hi'));
  assert.notEqual(await msg('user', 'hi'), await msg('assistant', 'hi'));
  assert.notEqual(await msg('user', 'hi'), await msg('user', 'hi', '2026-01-01'));
});

test('conversation hash is a Merle-style digest of ordered message hashes', async () => {
  const a = await hashes(['user', 'hi'], ['assistant', 'yo']);
  const b = await hashes(['user', 'hi'], ['assistant', 'yo']);
  assert.equal(await conversationContentHashFromHashes(a), await conversationContentHashFromHashes(b));
  const reordered = [a[1], a[0]];
  assert.notEqual(await conversationContentHashFromHashes(a), await conversationContentHashFromHashes(reordered));
});

test('sharedPrefixLength finds the shared opening run', () => {
  assert.equal(sharedPrefixLength(['a', 'b', 'c'], ['a', 'b', 'x']), 2);
  assert.equal(sharedPrefixLength(['a'], ['a', 'b']), 1);
  assert.equal(sharedPrefixLength([], ['a']), 0);
});

test('classification: the full vocabulary table', async () => {
  const base = await hashes(['user', 'one'], ['assistant', 'two']);
  const extended = await hashes(['user', 'one'], ['assistant', 'two'], ['user', 'three']);
  const prefix = await hashes(['user', 'one']);
  const branched = await hashes(['user', 'one'], ['assistant', 'DIFFERENT']);
  const disjoint = await hashes(['user', 'unrelated']);

  assert.equal(classifyHashes(base, undefined), 'added');
  assert.equal(classifyHashes(base, base), 'unchanged');
  assert.equal(classifyHashes(extended, base), 'extended');
  assert.equal(classifyHashes(prefix, base), 'prefix');
  assert.equal(classifyHashes(branched, base), 'branch');
  assert.equal(classifyHashes(disjoint, base), 'branch', 'same ID, no shared history is still a branch');
});

test('classification: empty incoming against stored is a prefix', () => {
  assert.equal(classifyHashes([], ['a']), 'prefix');
  assert.equal(classifyHashes([], undefined), 'added');
});

test('KINDS covers every reported classification', () => {
  assert.deepEqual(KINDS, ['added', 'unchanged', 'extended', 'prefix', 'branch']);
});

test('buildMergePlan counts every kind and never mutates the library', async () => {
  const conv = (id, ...specs) => ({ id, messages: specs.map(([r, c]) => ({ role: r, content: c })) });
  const library = emptyLibrary();
  const first = await buildMergePlan([conv('a', ['user', 'hi'])], library);
  assert.equal(first.report.added, 1);

  applyPlan(first, library, '2026-11-02T00:00:00Z');
  const snapshot = JSON.stringify(library);

  const second = await buildMergePlan([
    conv('a', ['user', 'hi']),
    conv('a', ['user', 'hi'], ['user', 'more']),
    conv('a', ['user', 'changed']),
    conv('a', ['user', 'hi']),
    conv('b', ['user', 'new']),
  ], library);

  assert.deepEqual(second.report, { added: 1, unchanged: 2, extended: 1, prefix: 0, branch: 1 });
  assert.equal(JSON.stringify(library), snapshot, 'plan building must not mutate');
});

test('applyPlan is additive: newer versions never overwrite earlier ones', async () => {
  const library = emptyLibrary();
  const convA = { id: 'a', messages: [{ role: 'user', content: 'hi' }] };
  const plan1 = await buildMergePlan([convA], library);
  applyPlan(plan1, library, '2026-11-02T00:00:00Z');

  const convA2 = { id: 'a', messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'more' }] };
  const plan2 = await buildMergePlan([convA2], library);
  applyPlan(plan2, library, '2026-11-02T01:00:00Z');

  assert.equal(library.conversations.a.versions.length, 2, 'both versions persist');
  assert.equal(library.conversations.a.versions[0].conversation.messages.length, 1, 'earlier version intact');
  assert.equal(library.conversations.a.versions[1].conversation.messages.length, 2);
  assert.equal(library.flagged.length, 0);
});

test('applyPlan flags prefix and branch conflicts without auto-resolving', async () => {
  const library = emptyLibrary();
  const full = { id: 'a', messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] };
  applyPlan(await buildMergePlan([full], library), library, '2026-11-02T00:00:00Z');

  const partial = { id: 'a', messages: [{ role: 'user', content: 'one' }] };
  const diverging = { id: 'a', messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'EDITED' }] };
  const plan = await buildMergePlan([partial, diverging], library);
  applyPlan(plan, library, '2026-11-02T01:00:00Z');

  assert.equal(library.flagged.filter((f) => f.kind === 'prefix').length, 1);
  assert.equal(library.flagged.filter((f) => f.kind === 'branch').length, 1);
  assert.equal(library.conversations.a.versions.length, 3, 'all three versions persist');
});

test('unchanged records an occurrence without a new version', async () => {
  const library = emptyLibrary();
  const conv = { id: 'a', messages: [{ role: 'user', content: 'hi' }] };
  applyPlan(await buildMergePlan([conv], library), library, '2026-11-02T00:00:00Z');
  applyPlan(await buildMergePlan([conv], library), library, '2026-11-03T00:00:00Z');
  assert.equal(library.conversations.a.versions.length, 1);
  assert.equal(library.conversations.a.occurrences.length, 1);
});

test('mergeBundleLineage: adds, validates, dedupes, and preserves', async () => {
  const library = emptyLibrary();
  const conv = { id: 'a', messages: [{ role: 'user', content: 'hi' }] };
  applyPlan(await buildMergePlan([conv], library), library, '2026-11-02T00:00:00Z');
  const known = library.conversations.a.versions[0];
  const newer = {
    contentHash: await conversationContentHashFromHashes([...known.messageHashes, 'aaaa'],),
    messageHashes: [...known.messageHashes, 'aaaa'],
    archivedAt: '2026-11-05T00:00:00Z',
  };
  const bundle = {
    conversations: {
      a: {
        versions: [known, newer, { contentHash: 'forged', messageHashes: ['not', 'matching'] }, { contentHash: 'x' }],
        occurrences: ['2026-11-06T00:00:00Z', '2026-11-02T00:00:00Z'],
      },
      ghost: { versions: [{ contentHash: await conversationContentHashFromHashes(['zz']), messageHashes: ['zz'] }] },
    },
    flagged: [
      { id: 'a', kind: 'branch', contentHash: 'c1' },
      { id: 'a', kind: 'branch', contentHash: 'c1' },
    ],
  };
  const report = await mergeBundleLineage(library, bundle, { archivedAt: '2026-11-07T00:00:00Z' });

  assert.equal(report.versionsAdded, 2, 'newer version + ghost version; known one is a duplicate');
  assert.equal(report.versionsInvalid, 2, 'forged + shapeless versions rejected');
  assert.equal(report.versionsDuplicate, 1, 'already-known version skipped');
  assert.equal(report.occurrencesAdded, 2, 'both bundle occurrences are new to an empty record');
  assert.equal(report.flaggedAdded, 1, 'flagged deduped on id+kind+hash');

  const versions = library.conversations.a.versions;
  assert.equal(versions.filter((v) => v.contentHash === known.contentHash).length, 1, 'no duplicate of known version');
  assert.equal(library.conversations.ghost.versions.length, 1, 'ghost lineage migrates');

  const again = await mergeBundleLineage(library, bundle);
  assert.equal(again.versionsAdded, 0, 'second merge adds nothing');
  assert.equal(again.occurrencesAdded, 0);
  assert.equal(again.flaggedAdded, 0);
});
