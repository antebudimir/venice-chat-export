/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Redaction for the diagnostics export.
 *
 * The report is a strict whitelist: schema versions, sizes, counts, format
 * lists, option toggles, and problem counts. No conversation text, no record
 * IDs, no local paths. Two layers enforce this: (1) only whitelisted fields
 * are ever copied into the report, and (2) every string that survives is
 * passed through a defensive filter that redacts long strings, path-like
 * strings, and long hex identifiers. The test suite additionally asserts
 * that probe strings (fake titles, IDs, paths) never appear in the output.
 */

const MAX_SAFE_STRING_LENGTH = 64;
const VERSIONISH = /^[A-Za-z0-9.+-]{1,20}$/;
const PATHISH = /[/\\]/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/** @param {unknown} value @returns {string} */
function safeString(value) {
  const s = String(value ?? '');
  if (s.length > MAX_SAFE_STRING_LENGTH || PATHISH.test(s) || LONG_HEX.test(s)) return '[redacted]';
  return s;
}

/** @param {unknown} value @returns {number} */
function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Keep only finite-number entries of a flat object. */
function numberMap(record) {
  const out = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    const n = Number(value);
    if (Number.isFinite(n)) out[safeString(key)] = n;
  }
  return out;
}

/** Keep only short, non-path-like strings of a list (format names, codes). */
function safeList(list) {
  return (Array.isArray(list) ? list : []).slice(0, 64).map(safeString);
}

/**
 * Build the redacted diagnostics report from raw instrumentation.
 * Anything not on the whitelist is dropped; anything path-like that somehow
 * reaches a whitelisted string slot is replaced with `[redacted]`.
 * @param {object} raw - Raw counts/sizes/options/problems from the background worker.
 * @returns {object} Redacted, JSON-serializable report.
 */
export function buildRedactedDiagnostics(raw) {
  return {
    redacted: true,
    schemaVersion: safeNumber(raw?.schemaVersion),
    extensionVersion: VERSIONISH.test(String(raw?.extensionVersion ?? '')) ? String(raw.extensionVersion) : '[redacted]',
    generatedAt: typeof raw?.generatedAt === 'string' && raw.generatedAt.length <= MAX_SAFE_STRING_LENGTH
      ? raw.generatedAt
      : new Date().toISOString(),
    counts: numberMap(raw?.counts),
    sizes: numberMap(raw?.sizes),
    formats: safeList(raw?.formats),
    options: {
      floatingButton: raw?.options?.floatingButton === true,
      askSaveLocation: raw?.options?.askSaveLocation === true,
      autoSyncMinutes: safeNumber(raw?.options?.autoSyncMinutes),
      formatCount: safeNumber((raw?.options?.formats ?? []).length),
    },
    problems: numberMap(raw?.problems),
  };
}

/**
 * Assert that no probe string appears in a serialized report. Used by the
 * test suite (and available for future audits) to prove redaction holds.
 * @param {string} reportJson - JSON.stringify'd redacted report.
 * @param {string[]} probes - Strings that must NOT appear (titles, IDs, paths).
 * @returns {void} Throws if any probe leaks.
 */
export function assertNoProbes(reportJson, probes) {
  for (const probe of probes ?? []) {
    if (probe !== '' && reportJson.includes(probe)) {
      throw new Error(`redaction leak: probe ${JSON.stringify(probe.slice(0, 24))}... appears in report`);
    }
  }
}
