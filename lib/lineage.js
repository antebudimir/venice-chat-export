/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Content hashing and lineage classification for Venice Vault.
 *
 * Pure module: WebCrypto only, no browser.* APIs, no DOM.
 *
 * Classification vocabulary (used verbatim in UI — do not paraphrase):
 * - `added`     — logical ID never seen before.
 * - `unchanged` — same ID, same conversation content hash.
 * - `extended`  — same ID, the stored message-hash list is a strict ordered
 *                 prefix of the incoming list (strict extension).
 * - `prefix`    — same ID, the incoming list is a strict ordered prefix of
 *                 the stored list; shared opening content without proven
 *                 identity. Flagged for review.
 * - `branch`    — same ID, shared history diverges or earlier content
 *                 changed. Both versions persist; never auto-resolved.
 * A newer version NEVER overwrites an earlier one — both persist.
 */

import { sha256Hex } from './filenames.js';

/** All lineage kinds, in report order. */
export const KINDS = ['added', 'unchanged', 'extended', 'prefix', 'branch'];

/**
 * Canonical JSON: recursively key-sorted, whitespace-free, `undefined`
 * dropped. Two records with equal canonical forms carry identical content.
 * @param {unknown} value - Any JSON-compatible value.
 * @returns {string} Canonical JSON text.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/**
 * Hash one message over its logical fields (role, content, ts).
 * @param {{ role?: string, content?: string, ts?: string|null }} message
 * @returns {Promise<string>} Hex digest.
 */
export async function hashMessage(message) {
  return sha256Hex(canonicalJson({
    content: String(message.content ?? ''),
    role: message.role ?? 'unknown',
    ts: message.ts ?? null,
  }));
}

/**
 * Hash every message of a conversation, in order.
 * @param {Array<{ role?: string, content?: string, ts?: string|null }>} messages
 * @returns {Promise<string[]>} Ordered hex digests.
 */
export async function hashConversationMessages(messages) {
  const hashes = [];
  for (const message of messages ?? []) hashes.push(await hashMessage(message));
  return hashes;
}

/**
 * Conversation content hash over an ordered list of message hashes.
 * Structural by design: a shared hash prefix is a shared history.
 * @param {string[]} messageHashes
 * @returns {Promise<string>} Hex digest.
 */
export function conversationContentHashFromHashes(messageHashes) {
  return sha256Hex(canonicalJson(messageHashes));
}

/**
 * Length of the shared opening run of two hash lists.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function sharedPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Classify the relationship between two message-hash lists.
 * @param {string[]} incomingHashes
 * @param {string[]|undefined} storedHashes - Undefined when the ID is new.
 * @returns {'added'|'unchanged'|'extended'|'prefix'|'branch'}
 */
export function classifyHashes(incomingHashes, storedHashes) {
  if (!Array.isArray(storedHashes) || storedHashes.length === 0) return 'added';
  if (incomingHashes.length === 0) return 'prefix';
  const shared = sharedPrefixLength(incomingHashes, storedHashes);
  if (incomingHashes.length === storedHashes.length) return shared === incomingHashes.length ? 'unchanged' : 'branch';
  if (shared === storedHashes.length) return 'extended';
  if (shared === incomingHashes.length) return 'prefix';
  return 'branch';
}

/**
 * Create an empty library record (stored under `vault:library`).
 * @returns {{ conversations: {}, flagged: Array, runs: Array }}
 */
export function emptyLibrary() {
  return { conversations: {}, flagged: [], runs: [] };
}

/**
 * Build a lineage merge plan for incoming conversations against the library.
 * Never mutates anything — background code applies the plan explicitly.
 * @param {Array<{ id: string, messages: Array }>} incomingConversations
 * @param {{ conversations?: Record<string, { versions?: Array<{ messageHashes: string[] }> }> }} [library]
 * @returns {Promise<{ report: Record<string, number>, entries: Array<{ id: string, kind: string, contentHash: string, messageHashes: string[], conversation: object }> }>}
 */
export async function buildMergePlan(incomingConversations, library) {
  const report = { added: 0, unchanged: 0, extended: 0, prefix: 0, branch: 0 };
  const entries = [];
  for (const conversation of incomingConversations ?? []) {
    const messageHashes = await hashConversationMessages(conversation.messages);
    const contentHash = await conversationContentHashFromHashes(messageHashes);
    const entry = library?.conversations?.[conversation.id];
    const latest = entry?.versions?.[entry.versions.length - 1];
    const kind = classifyHashes(messageHashes, latest?.messageHashes);
    report[kind] += 1;
    entries.push({ id: conversation.id, kind, contentHash, messageHashes, conversation });
  }
  return { report, entries };
}

/**
 * Apply a merge plan to a library, additively. `unchanged` records an
 * occurrence; every other kind appends a new immutable version (a newer
 * version never overwrites an earlier one). `prefix` and `branch` are also
 * recorded in `library.flagged` — they are never auto-resolved.
 * @param {{ entries: Array<{ id: string, kind: string, contentHash: string, messageHashes: string[], conversation: object }> }} plan
 * @param {{ conversations: {}, flagged: Array }} library - Mutated in place.
 * @param {string} archivedAt - ISO timestamp for version/occurrence records.
 * @returns {void}
 */
export function applyPlan(plan, library, archivedAt) {
  for (const e of plan.entries) {
    const record = library.conversations[e.id] ?? { versions: [], occurrences: [] };
    if (e.kind === 'unchanged') {
      record.occurrences.push(archivedAt);
    } else {
      record.versions.push({
        contentHash: e.contentHash,
        messageHashes: e.messageHashes,
        archivedAt,
        conversation: e.conversation,
      });
      if (e.kind === 'prefix' || e.kind === 'branch') {
        library.flagged.push({ id: e.id, kind: e.kind, detectedAt: archivedAt, contentHash: e.contentHash });
      }
    }
    library.conversations[e.id] = record;
  }
}

/**
 * Merge a bundle's lineage section into a library, additively (migration).
 * Used when importing a combined-bundle export so version history, occurrence
 * counts, and flagged conflicts survive a machine-to-machine move.
 *
 * Every incoming version is validated by recomputing its content hash from
 * its message hashes; a mismatch is skipped and counted (never silently
 * stored). Versions whose contentHash already exists for that ID are skipped
 * as duplicates. Flagged entries are deduped on id + kind + contentHash.
 * @param {{ conversations: {}, flagged: Array }} library - Mutated in place.
 * @param {{ conversations?: Record<string, { versions?: Array, occurrences?: Array }>, flagged?: Array }} bundleLineage
 * @param {{ archivedAt?: string }} [options]
 * @returns {Promise<{ versionsAdded: number, versionsDuplicate: number, versionsInvalid: number, occurrencesAdded: number, flaggedAdded: number }>}
 */
export async function mergeBundleLineage(library, bundleLineage, options = {}) {
  const archivedAt = options.archivedAt ?? new Date().toISOString();
  const report = { versionsAdded: 0, versionsDuplicate: 0, versionsInvalid: 0, occurrencesAdded: 0, flaggedAdded: 0 };
  for (const [id, entry] of Object.entries(bundleLineage?.conversations ?? {})) {
    const record = library.conversations[id] ?? { versions: [], occurrences: [] };
    const knownHashes = new Set(record.versions.map((v) => v.contentHash));
    for (const version of entry.versions ?? []) {
      if (!Array.isArray(version?.messageHashes) || typeof version?.contentHash !== 'string') {
        report.versionsInvalid += 1;
        continue;
      }
      const recomputed = await conversationContentHashFromHashes(version.messageHashes);
      if (recomputed !== version.contentHash) {
        report.versionsInvalid += 1;
        continue;
      }
      if (knownHashes.has(version.contentHash)) {
        report.versionsDuplicate += 1;
        continue;
      }
      record.versions.push({
        contentHash: version.contentHash,
        messageHashes: [...version.messageHashes],
        archivedAt: version.archivedAt ?? archivedAt,
        conversation: version.conversation ?? null,
      });
      knownHashes.add(version.contentHash);
      report.versionsAdded += 1;
    }
    for (const occurrence of entry.occurrences ?? []) {
      if (!record.occurrences.includes(occurrence)) {
        record.occurrences.push(occurrence);
        report.occurrencesAdded += 1;
      }
    }
    library.conversations[id] = record;
  }
  for (const item of bundleLineage?.flagged ?? []) {
    const duplicate = library.flagged.some((f) =>
      f.id === item.id && f.kind === item.kind && f.contentHash === item.contentHash);
    if (!duplicate) {
      library.flagged.push({ id: item.id, kind: item.kind, detectedAt: item.detectedAt ?? archivedAt, contentHash: item.contentHash });
      report.flaggedAdded += 1;
    }
  }
  return report;
}
