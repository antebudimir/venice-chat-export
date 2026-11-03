/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Background worker (module event page): message router, export/import
 * orchestration, file writes, hashing. Safety posture matches the Venice
 * Local Archive toolkit:
 * - snapshot before read: the raw scrape is persisted BEFORE any serialization;
 * - never mutate the source: the page is only ever read;
 * - never replace an earlier run: every filename is timestamped, downloads use
 *   conflictAction `uniquify`;
 * - continue past a single failure: per-conversation/per-format try/catch;
 * - explicit PASS: run status is PASS only when every write completed and
 *   nothing failed.
 */

import * as filenames from '../lib/filenames.js';
import * as lineage from '../lib/lineage.js';
import * as serialize from '../lib/serialize.js';
import { parseImport, detectFormat, normalizeConversation } from '../lib/parse.js';
import { extractHtmlPayload } from '../lib/html.js';
import { buildRedactedDiagnostics } from '../lib/redact.js';

const OPTIONS_KEY = 'vault:options';
const MY_VERSION = browser.runtime.getManifest().version;
const LIBRARY_KEY = 'vault:library';
const CAPTURE_PREFIX = 'vault:capture:';
const RUN_PREFIX = 'vault:run:';
const CONTENT_SCRIPT_FILES = ['lib/scrape.js', 'content/content.js'];
const VENICE_URL = /^https:\/\/venice\.ai\//;
const DEFAULT_OPTIONS = {
  formats: ['json'],
  floatingButton: false,
  filenameTemplate: filenames.DEFAULT_FILENAME_TEMPLATE,
  askSaveLocation: false,
  autoSyncMinutes: 0,
};

/** Localized string helper. */
function t(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) ?? key;
}

/** Log to the popup's quiet log (no-op when the popup is closed). */
async function log(message, level = 'info') {
  try {
    await browser.runtime.sendMessage({ type: 'vault:log', message, level });
  } catch {
    // popup closed — the run summary in storage.local keeps the record
  }
}

/** Report determinate progress to the popup (no-op when closed). */
async function progress(value, max) {
  try {
    await browser.runtime.sendMessage({ type: 'vault:progress', value, max });
  } catch {
    // popup closed
  }
}

/** Merge stored options over defaults. */
async function getOptions() {
  const stored = await browser.storage.local.get(OPTIONS_KEY);
  return { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] ?? {}) };
}

/** Load the library, creating the empty shape on first use. */
async function getLibrary() {
  const stored = await browser.storage.local.get(LIBRARY_KEY);
  return stored[LIBRARY_KEY] ?? lineage.emptyLibrary();
}

/**
 * Auto-inject on every venice.ai page load so the (optional) floating
 * button appears without requiring an export first. Injected scripts do not
 * survive navigation, hence the per-load re-injection. No-op unless the
 * floating-button option is enabled (default: off).
 */
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url ?? '';
  if (!VENICE_URL.test(url)) return;
  getOptions().then((options) => {
    if (options.floatingButton !== true) return;
    ensureContentScripts(tabId, options).catch(() => {});
  });
});

/**
 * Live-apply floating-button toggles: inject on open venice.ai tabs when
 * enabled, hide on already-injected tabs when disabled.
 */
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[OPTIONS_KEY]) return;
  const options = { ...DEFAULT_OPTIONS, ...(changes[OPTIONS_KEY].newValue ?? {}) };
  browser.tabs.query({ url: ['https://venice.ai/*'] }).then((tabs) => {
    for (const tab of tabs) {
      if (options.floatingButton === true) {
        ensureContentScripts(tab.id, options).catch(() => {});
      } else {
        browser.tabs.sendMessage(tab.id, { type: 'vault:configure', floatingButton: false }).catch(() => {});
      }
    }
  });
});

/** Find the active venice.ai tab, if any (host permission makes its URL visible). */
async function getActiveVeniceTab() {
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.find((tab) => typeof tab.url === 'string' && VENICE_URL.test(tab.url)) ?? null;
}

/** Inject the content scripts on demand, then ask the page to scrape. */
async function scrapeTab(tab, options) {
  let response = await browser.tabs.sendMessage(tab.id, { type: 'vault:scrape' }).catch(() => undefined);
  if (!isUsableResponse(response)) {
    await ensureContentScripts(tab.id, options);
    response = await browser.tabs.sendMessage(tab.id, { type: 'vault:scrape' }).catch(() => undefined);
  }
  if (!isUsableResponse(response)) {
    await log(t('logStaleReload'), 'warn');
    await browser.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    await ensureContentScripts(tab.id, options);
    response = await browser.tabs.sendMessage(tab.id, { type: 'vault:scrape' }).catch(() => undefined);
  }
  if (!isUsableResponse(response)) {
    const err = new Error(response?.message ?? 'no usable scrape response');
    err.code = 'scrape-failed';
    throw err;
  }
  return response;
}

/** Resolve (or reject) when a download reaches a terminal state. */
function waitForDownload(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        browser.downloads.onChanged.removeListener(listener);
        resolve(delta.state.current === 'complete');
      }
    };
    browser.downloads.onChanged.addListener(listener);
  });
}

/**
 * Write one file through the Downloads API (the primary Firefox path).
 * @param {string} relativeName - `/`-separated name relative to Downloads.
 * @param {string} text - UTF-8 file body.
 * @param {boolean} saveAs - Open a save dialog per file.
 * @returns {Promise<{ ok: boolean, filename?: string, error?: string }>}
 */
async function downloadFile(relativeName, text, saveAs) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  try {
    const id = await browser.downloads.download({
      url,
      filename: relativeName,
      saveAs: saveAs === true,
      conflictAction: 'uniquify',
    });
    const complete = await waitForDownload(id);
    if (!complete) return { ok: false, error: 'download-incomplete' };
    return { ok: true, filename: relativeName };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Write one export file through the Downloads API (the only write path —
 * Firefox exposes no writable picked-folder API, and the archive-folder
 * feature was removed in v0.3.0; see README).
 * @param {string} relativeName
 * @param {string} text
 * @param {{ askSaveLocation?: boolean }} options
 * @returns {Promise<{ ok: boolean, filename?: string, error?: string }>}
 */
async function writeFile(relativeName, text, options) {
  return downloadFile(relativeName, text, options.askSaveLocation);
}

/**
 * Run one export: scrape the active venice.ai tab, snapshot the capture
 * before any serialization, merge lineage additively, then write each
 * requested format, continuing past individual failures.
 * @returns {Promise<object>} Run summary (PASS/FAILED + the three counts).
 */
async function runExport() {
  const startedAt = new Date();
  const options = await getOptions();
  const tab = await getActiveVeniceTab();
  if (!tab) {
    await log(t('errNoVeniceTab'), 'error');
    return { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: [{ stage: 'tab', error: 'no-venice-tab' }] };
  }
  await log(t('logScrapeStart'));
  let scraped;
  try {
    scraped = await scrapeTab(tab, options);
    if (!scraped?.ok) throw new Error(scraped?.message ?? 'scrape failed');
  } catch (e) {
    const code = e?.code ?? scraped?.code ?? 'scrape-failed';
    const rawError = String(e?.message ?? code);
    if (/Missing host permission/i.test(rawError)) {
      await log(t('errHostPermission'), 'error');
    } else {
      await log(t(code === 'zero-messages' ? 'errZeroMessages' : 'errScrapeFailed', [rawError]), 'error');
    }
    return { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: [{ stage: 'scrape', error: code }] };
  }
  await log(t('logTierMatched', [String(scraped.tier), scraped.tierDescription]));
  for (const warning of scraped.warnings ?? []) {
    await log(t('logWarning', [warning.code, warning.detail ?? '']), 'warn');
  }

  // Normalize BEFORE serializing so every export carries the per-message
  // hash and conversation contentHash the schema promises (import recomputes
  // the same values, so round-trips verify).
  const normalizeWarnings = [];
  const conversations = [];
  for (const conv of scraped.conversations ?? []) {
    conversations.push(await normalizeConversation(conv, normalizeWarnings));
  }
  for (const warning of normalizeWarnings) {
    await log(t('logWarning', [warning.code, warning.detail ?? '']), 'warn');
  }
  const messageCount = conversations.reduce((n, c) => n + (c.messages?.length ?? 0), 0);

  // Snapshot before read: persist the raw capture BEFORE serializing anything.
  const slug = filenames.timestampSlug(startedAt);
  await browser.storage.local.set({
    [CAPTURE_PREFIX + slug]: {
      capturedAt: startedAt.toISOString(),
      sourceUrl: tab.url,
      tier: scraped.tier,
      warnings: scraped.warnings ?? [],
      conversations,
    },
  });
  await log(t('logCaptureStored'));

  // Lineage merge (additive; prefix/branch flagged, never auto-resolved).
  const library = await getLibrary();
  const plan = await lineage.buildMergePlan(conversations, library);
  lineage.applyPlan(plan, library, startedAt.toISOString());
  await browser.storage.local.set({ [LIBRARY_KEY]: library });
  await log(t('logMerged', [String(plan.report.added), String(plan.report.unchanged), String(plan.report.extended), String(plan.report.prefix), String(plan.report.branch)]));

  const runTitle = conversations.length === 1 ? (conversations[0].title || 'export') : 'export';
  const writePhase = await serializeAndWrite(conversations, options, startedAt, library, runTitle);
  const { snapshotFileCount, written, failures: writeFailures } = writePhase;
  let failures = writeFailures;

  if (snapshotFileCount === 0 && failures.length > 0 && failures.some((f) => f.error === 'folder-permission-denied')) {
    await log(t('errFolderPermission'), 'error');
  }
  const status = failures.length === 0 && snapshotFileCount > 0 ? 'PASS' : 'FAILED';
  const summary = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    snapshotFileCount,
    conversationCount: conversations.length,
    messageCount,
    formats: options.formats ?? ['json'],
    written,
    failures,
    mergeReport: plan.report,
  };
  await browser.storage.local.set({ [RUN_PREFIX + slug]: summary });
  const library2 = await getLibrary();
  library2.runs.push({ at: summary.finishedAt, status, snapshotFileCount, conversationCount: conversations.length, messageCount });
  await browser.storage.local.set({ [LIBRARY_KEY]: library2 });
  if (status === 'PASS') {
    await log(t('logRunPass'));
  } else {
    await log(t('logRunFailed', [String(failures.length)]), 'error');
  }
  return summary;
}

/** Wait for `ms` milliseconds (crawl pacing). */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crawl pacing and readiness timeouts. */
const BULK_DELAY_MS = 1500;
const BULK_READY_TIMEOUT_MS = 20000;
let bulkCancelRequested = false;

/**
 * Poll a freshly opened tab until its content script scrapes successfully.
 * Single-page apps often report `complete` before messages render, so the
 * scrape is retried until the timeout; timeouts raise zero-messages.
 * @param {number} tabId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>} The scrape result.
 */
async function waitForScrape(tabId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? BULK_READY_TIMEOUT_MS);
  let lastError = 'no response from the page';
  while (Date.now() < deadline) {
    try {
      const result = await browser.tabs.sendMessage(tabId, { type: 'vault:scrape' });
      if (result?.ok && result?.v === MY_VERSION) return result;
      lastError = result?.message ?? 'scrape not ok';
    } catch (e) {
      lastError = String(e?.message ?? e);
    }
    await wait(1000);
  }
  const err = new Error(lastError);
  err.code = 'zero-messages';
  throw err;
}

/**
 * Resolve when a tab reports `status: complete` (or when it is removed, or
 * after the timeout — whichever comes first).
 * @param {number} tabId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish();
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    setTimeout(finish, options.timeoutMs ?? BULK_READY_TIMEOUT_MS);
  });
}

/**
 * A scrape/list response is usable only when it came from content scripts
 * of the CURRENT extension version. An extension update leaves old injected
 * scripts alive in already-open pages (the injected files refuse to re-run
 * inside the same document), and stale scripts keep answering with old
 * capabilities — the source of truncated/missing exports after updates.
 */
function isUsableResponse(response) {
  return response?.ok === true && response?.v === MY_VERSION;
}

async function ensureContentScripts(tabId, options) {
  await browser.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
  await browser.tabs.sendMessage(tabId, { type: 'vault:configure', floatingButton: options.floatingButton === true }).catch(() => {});
}

/**
 * Serialize the requested formats and write every entry, continuing past
 * individual failures. Shared by single-conversation and bulk exports.
 * @param {Array<object>} conversations
 * @param {object} options - Vault options (formats, filenameTemplate, askSaveLocation).
 * @param {Date} startedAt
 * @param {object} library
 * @param {string} runTitle
 * @returns {Promise<{ snapshotFileCount: number, written: string[], failures: Array<object> }>}
 */
async function serializeAndWrite(conversations, options, startedAt, library, runTitle) {
  const formats = Array.isArray(options.formats) && options.formats.length > 0 ? options.formats : ['json'];
  const failures = [];
  const written = [];
  let snapshotFileCount = 0;
  const entriesByFormat = new Map();
  let total = 0;
  for (const format of formats) {
    try {
      const entries = serialize.buildExportEntries(format, conversations, {
        exportedAt: startedAt.toISOString(),
        runTitle,
        library,
      });
      entriesByFormat.set(format, entries);
      total += entries.length;
    } catch (e) {
      failures.push({ stage: 'serialize', format, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  let done = 0;
  for (const [format, entries] of entriesByFormat) {
    for (const entry of entries) {
      try {
        const name = await filenames.buildFileName(options.filenameTemplate, {
          title: entry.title,
          ext: entry.ext,
          at: startedAt,
        });
        const result = await writeFile(name, entry.text, options);
        if (result.ok) {
          snapshotFileCount += 1;
          written.push(result.filename ?? name);
          await log(t('logFileWritten', [result.filename ?? name]));
        } else {
          throw new Error(result.error ?? 'write-failed');
        }
      } catch (e) {
        failures.push({ stage: 'write', format, file: entry.title, error: String(e?.message ?? e).slice(0, 200) });
        await log(t('logFileFailed', [`${entry.title}.${entry.ext}`, String(e?.message ?? e)]), 'error');
      }
      done += 1;
      await progress(done, total);
    }
  }
  return { snapshotFileCount, written, failures };
}

/**
 * Finish a run: write summary to storage, record it in the library runs,
 * log PASS/FAILED, and return the summary object.
 */
async function finishRun(startedAt, slug, summary) {
  await browser.storage.local.set({ [RUN_PREFIX + slug]: summary });
  const library = await getLibrary();
  library.runs.push({
    at: summary.finishedAt,
    status: summary.status,
    snapshotFileCount: summary.snapshotFileCount,
    conversationCount: summary.conversationCount,
    messageCount: summary.messageCount,
  });
  await browser.storage.local.set({ [LIBRARY_KEY]: library });
  if (summary.status === 'PASS') await log(t('logRunPass'));
  else await log(t('logRunFailed', [String(summary.failures.length)]), 'error');
  return summary;
}

/**
 * Export ALL conversations the Venice web app lists: scrape the conversation
 * list, then visit each conversation in its own background tab, scrape it,
 * close the tab, and continue past failures. Cancel between conversations.
 * Only conversations visible in the list UI can be exported — the count is
 * logged and the run is bounded by the list UI itself.
 * @returns {Promise<object>} Run summary.
 */
async function runExportAll() {
  const startedAt = new Date();
  const options = await getOptions();
  const tab = await getActiveVeniceTab();
  if (!tab) {
    await log(t('errNoVeniceTab'), 'error');
    return { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: [{ stage: 'tab', error: 'no-venice-tab' }] };
  }
  let list = null;
  let lastListError = '';
  try {
    const askForList = () => browser.tabs.sendMessage(tab.id, { type: 'vault:scrape-list' })
      .then((res) => res)
      .catch((e) => { lastListError = String(e?.message ?? e); return null; });
    list = await askForList();
    if (!isUsableResponse(list)) {
      await ensureContentScripts(tab.id, options).catch((e) => { lastListError = String(e?.message ?? e); });
      list = await askForList();
    }
    if (!isUsableResponse(list)) {
      // stale injected scripts from an older extension version — reload once
      lastListError = 'stale content script detected — reloading the tab';
      await log(t('logStaleReload'), 'warn');
      await browser.tabs.reload(tab.id);
      await waitForTabComplete(tab.id);
      await ensureContentScripts(tab.id, options);
      list = await askForList();
    }
    if (!list?.ok) throw new Error(list?.message ?? lastListError ?? 'list scrape failed');
  } catch (e) {
    const raw = String(e?.message ?? e);
    if (/Missing host permission/i.test(raw)) {
      await log(t('errHostPermission'), 'error');
    } else {
      await log(t('errNoConversationList', [raw]), 'error');
    }
    return { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: [{ stage: 'list', error: raw }] };
  }
  const items = list.conversations ?? [];
  if (items.length === 0) {
    await log(t('errNoConversationList', ['zero conversation links found — open the chats list view and try again']), 'error');
    return { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: [{ stage: 'list', error: 'zero-links' }] };
  }
  await log(t('logBulkListScraped', [String(items.length)]));

  const conversations = [];
  const scrapeFailures = [];
  const seenIds = new Set();
  const chromeFingerprints = new Map();
  const bulkNormalizeWarnings = [];
  let done = 0;
  let cancelled = false;
  bulkCancelRequested = false;
  let crawlTab = null;
  try {
    // ONE reusable background tab: navigated conversation by conversation.
    // (Injected scripts do not survive navigation, so each visit re-injects.)
    try {
      crawlTab = await browser.tabs.create({ url: items[0].url, active: false });
    } catch (e) {
      throw new Error('could not open a background tab: ' + String(e?.message ?? e));
    }
    for (const item of items) {
      if (bulkCancelRequested) {
        cancelled = true;
        await log(t('logBulkCancelled'));
        break;
      }
      try {
        await browser.tabs.update(crawlTab.id, { url: item.url });
        await waitForTabComplete(crawlTab.id);
        await ensureContentScripts(crawlTab.id, options);
        const scraped = await waitForScrape(crawlTab.id);
        if (!scraped?.ok) throw new Error(scraped?.message ?? 'scrape failed');
        // Chrome guard: page furniture (sidebar, drag-and-drop hints) is
        // identical on every conversation page. If two DIFFERENT conversation
        // URLs yield byte-identical short message sets, the visit captured
        // chrome, not conversation content — fail this item, store nothing.
        const fingerprint = JSON.stringify((scraped.conversations ?? []).map((c) => c.messages));
        const totalChars = (scraped.conversations ?? []).reduce((n, c) => n + (c.messages ?? []).reduce((m, msg) => m + (msg.content?.length ?? 0), 0), 0);
        const priorUrl = chromeFingerprints.get(fingerprint);
        if (priorUrl && priorUrl !== item.url && totalChars < 2000) {
          throw new Error('page chrome scraped instead of conversation content (identical to an earlier visit)');
        }
        chromeFingerprints.set(fingerprint, item.url);
        let archivedTitle = null;
        for (const conv of scraped.conversations ?? []) {
          // Bulk flow trusts the sidebar title: the visiting tab's own title
          // is often the generic site name while the SPA is hydrating.
          const normalized = await normalizeConversation({ ...conv, title: item.title || conv.title || 'Untitled' }, bulkNormalizeWarnings);
          const id = item.id && !normalized.id?.startsWith?.('derived-') ? item.id : normalized.id;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          archivedTitle = normalized.title;
          conversations.push({ ...normalized, id, title: archivedTitle });
        }
        await log(t('logBulkItemDone', [String(done + 1), String(items.length), archivedTitle ?? item.title ?? item.id]));
      } catch (e) {
        const rawError = String(e?.message ?? e);
        scrapeFailures.push({ stage: 'scrape', url: item.url, error: rawError.slice(0, 200) });
        await log(t('logBulkItemFailed', [item.title ?? item.id, rawError]), 'error');
        if (/Missing host permission/i.test(rawError)) {
          // The grant is global — retrying other URLs cannot succeed. Fail
          // fast with the actionable instruction instead of N identical lines.
          await log(t('errHostPermission'), 'error');
          break;
        }
      } finally {
        done += 1;
        await progress(done, items.length);
        await wait(BULK_DELAY_MS);
      }
    }
  } finally {
    if (crawlTab) await browser.tabs.remove(crawlTab.id).catch(() => {});
  }

  if (conversations.length === 0) {
    const summary = { status: 'FAILED', snapshotFileCount: 0, conversationCount: 0, messageCount: 0, failures: scrapeFailures };
    return finishRun(startedAt, filenames.timestampSlug(startedAt), summary);
  }

  const slug = filenames.timestampSlug(startedAt);
  await browser.storage.local.set({
    [CAPTURE_PREFIX + slug]: {
      capturedAt: startedAt.toISOString(),
      sourceUrl: tab.url,
      mode: 'all',
      listedCount: items.length,
      warnings: [],
      conversations,
    },
  });
  await log(t('logCaptureStored'));

  const library = await getLibrary();
  const plan = await lineage.buildMergePlan(conversations, library);
  lineage.applyPlan(plan, library, startedAt.toISOString());
  await browser.storage.local.set({ [LIBRARY_KEY]: library });
  await log(t('logMerged', [String(plan.report.added), String(plan.report.unchanged), String(plan.report.extended), String(plan.report.prefix), String(plan.report.branch)]));

  const bulkRunTitle = conversations.length === 1 ? (conversations[0].title || 'export-all') : 'export-all';
  const writePhase = await serializeAndWrite(conversations, options, startedAt, library, bulkRunTitle);
  const failures = [...scrapeFailures, ...writePhase.failures];
  const scrapedCount = conversations.length;
  const complete = !cancelled && scrapeFailures.length === 0;
  const status = writePhase.failures.length === 0 && writePhase.snapshotFileCount > 0 && complete ? 'PASS' : (writePhase.snapshotFileCount > 0 && !cancelled && scrapeFailures.length > 0 ? 'FAILED' : (cancelled && writePhase.snapshotFileCount > 0 ? 'PARTIAL' : 'FAILED'));
  const messageCount = conversations.reduce((n, c) => n + (c.messages?.length ?? 0), 0);
  const summary = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    listedCount: items.length,
    snapshotFileCount: writePhase.snapshotFileCount,
    conversationCount: scrapedCount,
    messageCount,
    formats: options.formats ?? ['json'],
    written: writePhase.written,
    failures,
    mergeReport: plan.report,
  };
  return finishRun(startedAt, slug, summary);
}

/**
 * Parse a set of import files (pure parse.js, HTML via lib/html.js) and
 * build the lineage merge plan against the stored library. Dry-run only —
 * nothing is written until the popup sends `vault:import:commit`.
 * @param {Array<{ name: string, text: string }>} files
 * @returns {Promise<object>} { report, conversationCount, messageCount, errors, warnings }
 */
async function runImportInspect(files) {
  const errors = [];
  const warnings = [];
  const conversations = [];
  for (const file of files ?? []) {
    try {
      const format = detectFormat(file.name, file.text);
      if (format === 'html') {
        const payload = extractHtmlPayload(file.text);
        if (payload.jsonText) {
          const parsed = await parseImport('payload.json', payload.jsonText);
          conversations.push(...parsed.conversations);
          warnings.push(...parsed.warnings);
        } else if (payload.conversations) {
          const parsed = await Promise.all(payload.conversations.map((c) => parseImport('conv.txt', JSON.stringify({ schemaVersion: 1, conversations: [c] }))));
          for (const p of parsed) {
            conversations.push(...p.conversations);
            warnings.push(...p.warnings);
          }
        } else {
          throw new Error('no embedded payload and no recognizable conversation markup');
        }
      } else {
        const parsed = await parseImport(file.name, file.text);
        conversations.push(...parsed.conversations);
        warnings.push(...parsed.warnings);
      }
    } catch (e) {
      errors.push({ name: file.name, code: e?.code ?? 'malformed', message: String(e?.message ?? e).slice(0, 200) });
    }
  }
  const library = await getLibrary();
  const plan = await lineage.buildMergePlan(conversations, library);
  return {
    report: plan.report,
    conversationCount: conversations.length,
    messageCount: conversations.reduce((n, c) => n + (c.messages?.length ?? 0), 0),
    errors,
    warnings,
  };
}

/**
 * Commit an import: re-run the plan and apply it additively (identical to
 * the inspected plan unless the library changed in between). Prefix/branch
 * conflicts are recorded under `flagged` and never auto-resolved.
 * @param {Array<{ name: string, text: string }>} files
 * @returns {Promise<object>} Commit summary with the merge report.
 */
async function runImportCommit(files) {
  const inspected = await runImportInspect(files);
  if (inspected.conversationCount === 0) {
    return { status: 'FAILED', ...inspected };
  }
  const conversations = [];
  for (const file of files ?? []) {
    try {
      const format = detectFormat(file.name, file.text);
      if (format === 'html') continue; // re-parsed below via the same path
      const parsed = await parseImport(file.name, file.text);
      conversations.push(...parsed.conversations);
    } catch {
      // already reported by inspect; commit only what parsed cleanly
    }
  }
  const htmlConversations = [];
  for (const file of files ?? []) {
    if (detectFormat(file.name, file.text) !== 'html') continue;
    const payload = extractHtmlPayload(file.text);
    const texts = [];
    if (payload.jsonText) texts.push(payload.jsonText);
    for (const c of payload.conversations ?? []) texts.push(JSON.stringify({ schemaVersion: 1, conversations: [c] }));
    for (const text of texts) {
      try {
        const parsed = await parseImport('payload.json', text);
        htmlConversations.push(...parsed.conversations);
      } catch {
        // already reported by inspect
      }
    }
  }
  const library = await getLibrary();
  const plan = await lineage.buildMergePlan([...conversations, ...htmlConversations], library);
  const archivedAt = new Date().toISOString();
  lineage.applyPlan(plan, library, archivedAt);

  // Bundle migration: carry over version history, occurrences, and flagged
  // conflicts. Each stored version is hash-validated by mergeBundleLineage;
  // invalid entries are skipped and counted, never silently stored.
  const lineageTotals = { versionsAdded: 0, versionsDuplicate: 0, versionsInvalid: 0, occurrencesAdded: 0, flaggedAdded: 0 };
  for (const file of files ?? []) {
    try {
      if (detectFormat(file.name, file.text) !== 'json') continue;
      const data = JSON.parse(file.text);
      if (data?.lineage && typeof data.lineage === 'object') {
        const report = await lineage.mergeBundleLineage(library, data.lineage, { archivedAt });
        for (const key of Object.keys(lineageTotals)) lineageTotals[key] += report[key] ?? 0;
      }
    } catch {
      // malformed JSON was already reported by inspect; never block the commit
    }
  }
  await browser.storage.local.set({ [LIBRARY_KEY]: library });
  await log(t('logImportCommitted', [String(plan.report.added), String(plan.report.extended)]));
  if (lineageTotals.versionsAdded > 0 || lineageTotals.flaggedAdded > 0) {
    await log(t('logImportLineageMerged', [String(lineageTotals.versionsAdded), String(lineageTotals.occurrencesAdded), String(lineageTotals.flaggedAdded), String(lineageTotals.versionsInvalid)]));
  }
  return { status: 'PASS', archivedAt, ...inspected, report: plan.report, lineage: lineageTotals };
}

/**
 * Build and write the redacted diagnostics report: sizes, counts, schema
 * versions, problem counts only — no conversation text, no record IDs, no
 * local paths (enforced by lib/redact.js and its test suite).
 * @returns {Promise<object>} { ok, filename?, error? }
 */
async function runDiagnostics() {
  const options = await getOptions();
  const library = await getLibrary();
  const all = await browser.storage.local.get(null);
  const captureEntries = Object.entries(all).filter(([key]) => key.startsWith(CAPTURE_PREFIX));
  const runEntries = Object.entries(all).filter(([key]) => key.startsWith(RUN_PREFIX));
  const sizes = {};
  let totalBytes = 0;
  let maxBytes = 0;
  let totalConversations = 0;
  let totalMessages = 0;
  let totalVersions = 0;
  for (const [, record] of Object.entries(library.conversations ?? {})) {
    totalVersions += record.versions?.length ?? 0;
    for (const version of record.versions ?? []) {
      const bytes = new TextEncoder().encode(JSON.stringify(version.conversation ?? {})).length;
      totalBytes += bytes;
      if (bytes > maxBytes) maxBytes = bytes;
      totalConversations += 1;
      totalMessages += version.conversation?.messages?.length ?? 0;
    }
  }
  sizes.conversationTotalBytes = totalBytes;
  sizes.conversationMaxBytes = maxBytes;
  sizes.conversationAvgBytes = totalConversations > 0 ? Math.round(totalBytes / totalConversations) : 0;
  let failedRuns = 0;
  let passedRuns = 0;
  for (const [, run] of runEntries) {
    if (run?.status === 'PASS') passedRuns += 1;
    else failedRuns += 1;
  }
  const report = buildRedactedDiagnostics({
    schemaVersion: serialize.SCHEMA_VERSION,
    extensionVersion: browser.runtime.getManifest().version,
    generatedAt: new Date().toISOString(),
    counts: {
      captures: captureEntries.length,
      runs: runEntries.length,
      logicalConversations: Object.keys(library.conversations ?? {}).length,
      immutableVersions: totalVersions,
      messages: totalMessages,
      flagged: (library.flagged ?? []).length,
    },
    sizes,
    formats: options.formats ?? [],
    options: {
      floatingButton: options.floatingButton,
      askSaveLocation: options.askSaveLocation,
      autoSyncMinutes: options.autoSyncMinutes,
      formats: options.formats ?? [],
    },
    problems: { failedRuns, passedRuns, importRunFailures: failedRuns },
  });
  const name = `venice-vault-diagnostics-${filenames.timestampSlug(new Date())}.json`;
  const result = await downloadFile(name, JSON.stringify(report, null, 2) + '\n', false);
  if (result.ok) await log(t('logDiagnosticsWritten', [result.filename ?? name]));
  else await log(t('logFileFailed', [name, result.error ?? '']), 'error');
  return result;
}

/**
 * Status for the popup: last run time and whether the (off-by-default)
 * auto-sync interval is due. Auto-sync is a reminder, not a scheduler —
 * this extension has no `alarms` permission and runs nothing in the
 * background on its own.
 * @returns {Promise<object>}
 */
async function getStatus() {
  const options = await getOptions();
  const library = await getLibrary();
  const lastRun = library.runs?.[library.runs.length - 1] ?? null;
  let dueForSync = false;
  if (options.autoSyncMinutes > 0 && lastRun?.at) {
    const elapsedMs = Date.now() - new Date(lastRun.at).getTime();
    dueForSync = elapsedMs >= options.autoSyncMinutes * 60_000;
  } else if (options.autoSyncMinutes > 0 && !lastRun) {
    dueForSync = true;
  }
  return {
    lastRunAt: lastRun?.at ?? null,
    lastRunStatus: lastRun?.status ?? null,
    autoSyncMinutes: options.autoSyncMinutes,
    dueForSync,
    flaggedCount: (library.flagged ?? []).length,
    logicalConversationCount: Object.keys(library.conversations ?? {}).length,
  };
}

/** Wipe every stored record (explicit, confirmed user action in options). */
async function clearData() {
  await browser.storage.local.clear();
  await log(t('logDataCleared'));
  return { ok: true };
}

/** Message router — Firefox supports Promise-returning listeners. */
browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'vault:open-options': return browser.runtime.openOptionsPage();
    case 'vault:export': return runExport();
    case 'vault:export:all': return runExportAll();
    case 'vault:export:all:cancel':
      bulkCancelRequested = true;
      return Promise.resolve({ ok: true });
    case 'vault:import:inspect': return runImportInspect(message.files);
    case 'vault:import:commit': return runImportCommit(message.files);
    case 'vault:diagnostics': return runDiagnostics();
    case 'vault:status': return getStatus();
    case 'vault:clear-data': return clearData();
    default: return undefined;
  }
});
