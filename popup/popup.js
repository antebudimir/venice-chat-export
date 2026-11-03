/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Popup controller: permission grant, exports (single + bulk), quiet log,
 * determinate progress. v0.3.0: the archive-folder picker and the popup
 * import flow were removed — Firefox closes extension popups when a file
 * dialog opens, which made both dead code. Imports run from the Options
 * page (a real tab, which survives file dialogs). The three-count
 * vocabulary (snapshot file count / conversation count / message count) is
 * always rendered together so no count can imply another.
 */

const OPTIONS_KEY = 'vault:options';
const VENICE_ORIGIN = { origins: ['https://venice.ai/*'] };
const CURRENT_RUN_KEY = 'vault:currentRun';
const FORMAT_LABEL_KEYS = {
  json: 'formatJson', markdown: 'formatMarkdown', html: 'formatHtml', bundle: 'formatBundle',
};

const $ = (id) => document.getElementById(id);
const t = (key, subs) => browser.i18n.getMessage(key, subs) || key;

/** Apply _locales strings to every data-i18n / data-i18n-aria element. */
function localize() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

/** Append one line to the quiet log (newest last), then scroll it into view. */
function logLine(message, level = 'info') {
  const line = document.createElement('p');
  line.className = `vv-log-line vv-log-${level}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time} ${message}`;
  const logBox = $('log');
  logBox.append(line);
  logBox.scrollTop = logBox.scrollHeight;
}

/** Update the determinate progress bar (never a spinner-only state). */
function setProgress(value, max) {
  const bar = $('progress');
  const fill = $('progress-fill');
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  fill.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
}

/** Render the three distinct counts, named, together — never one alone. */
function setCountsSummary(snapshotFiles, conversations, messages, status) {
  const line = t('countsSummary', [String(snapshotFiles), String(conversations), String(messages)]);
  const statusLabel = status === 'PASS' ? t('statusPass') : t('statusFailed');
  $('counts-summary').textContent = `${line} · ${statusLabel}`;
}

/** Show active export formats as localized names. */
async function refreshFormatsLine() {
  const stored = await browser.storage.local.get(OPTIONS_KEY);
  const options = stored[OPTIONS_KEY] ?? {};
  const formats = Array.isArray(options.formats) && options.formats.length > 0 ? options.formats : ['json'];
  $('formats-line').textContent = t('formatsActive', [formats.map((f) => t(FORMAT_LABEL_KEYS[f] ?? f)).join(', ')]);
}

/** Refresh last-run info and the (off-by-default) auto-sync reminder. */
async function refreshStatus() {
  try {
    const status = await browser.runtime.sendMessage({ type: 'vault:status' });
    if (status?.dueForSync === true) {
      $('sync-status').textContent = t('syncDue', [String(status.autoSyncMinutes)]);
      $('sync-status').hidden = false;
    }
    $('source-status').textContent = status?.lastRunAt
      ? t('sourceLastRun', [new Date(status.lastRunAt).toLocaleString(), status.lastRunStatus === 'PASS' ? t('statusPass') : t('statusFailed')])
      : t('sourceNoRuns');
  } catch {
    $('source-status').textContent = t('sourceNoRuns');
  }
}

/**
 * MV3 host permissions start OFF for freshly loaded extensions and reset on
 * every temporary reload. Check the venice.ai grant; when missing, show the
 * banner with a Grant button. On success the banner flips to a disabled
 * "Access granted" state and fades after 4s — visible feedback, not just a
 * quiet log line.
 * @returns {Promise<boolean>} True when venice.ai access is granted.
 */
async function checkHostPermission() {
  let granted = true;
  try {
    granted = await browser.permissions.contains(VENICE_ORIGIN);
  } catch {
    granted = true; // permissions API hiccup — do not block the UI on it
  }
  const banner = $('host-permission-banner');
  if (granted) {
    banner.hidden = true;
    return true;
  }
  banner.hidden = false;
  const button = $('btn-grant-permission');
  button.onclick = () => {
    browser.runtime.openOptionsPage()
      .catch((e) => logLine(t('errUnexpected', [String(e?.message ?? e)]), 'error'));
  };
  return false;
}

/** Live event subscription — attached only while a run is in flight. */
let liveListener = null;
function subscribeLive() {
  if (liveListener) return;
  liveListener = (message) => {
    if (message?.type === 'vault:log') logLine(message.message, message.level ?? 'info');
    if (message?.type === 'vault:progress') setProgress(message.value, message.max);
  };
  browser.runtime.onMessage.addListener(liveListener);
}
function unsubscribeLive() {
  if (!liveListener) return;
  browser.runtime.onMessage.removeListener(liveListener);
  liveListener = null;
}

/** Render a persisted run from vault:currentRun on popup open. */
async function restoreCurrentRun() {
  let run = null;
  try {
    run = (await browser.storage.local.get(CURRENT_RUN_KEY))[CURRENT_RUN_KEY];
  } catch {
    return false;
  }
  if (!run) return false;
  for (const entry of run.log ?? []) logLine(entry.message, entry.level ?? 'info');
  if (run.status === 'running') {
    let alive = true;
    try {
      await browser.runtime.sendMessage({ type: 'vault:ping' });
    } catch {
      alive = false; // background worker died mid-run
    }
    if (!alive) {
      logLine(t('runInterrupted'), 'error');
      setCountsSummary(run.snapshotFileCount ?? 0, run.conversationCount ?? 0, run.messageCount ?? 0, 'FAILED');
      return true;
    }
    setProgress(run.done ?? 0, run.total ?? 0);
    $('btn-export').disabled = true;
    $('btn-export-all').disabled = true;
    $('btn-export-cancel').hidden = false;
    subscribeLive();
    logLine(t('runRestoredLive'));
    return true;
  }
  setCountsSummary(run.snapshotFileCount ?? 0, run.conversationCount ?? 0, run.messageCount ?? 0, run.status);
  return true;
}

/** Shared export flow: disable buttons, stream progress/log, PASS gate. */
async function runExport(messageType, startedKey) {
  const exportButton = $('btn-export');
  const allButton = $('btn-export-all');
  const cancelButton = $('btn-export-cancel');
  exportButton.disabled = true;
  allButton.disabled = true;
  if (messageType === 'vault:export:all') cancelButton.hidden = false;
  setProgress(0, 0);
  subscribeLive();
  logLine(t(startedKey));
  try {
    const summary = await browser.runtime.sendMessage({ type: messageType });
    setCountsSummary(summary.snapshotFileCount, summary.conversationCount, summary.messageCount, summary.status);
    if (summary.listedCount != null) {
      logLine(t('logBulkDone', [String(summary.conversationCount), String(summary.listedCount), String(summary.failures.length)]));
    }
  } catch (e) {
    logLine(t('errUnexpected', [String(e?.message ?? e)]), 'error');
  } finally {
    unsubscribeLive();
    exportButton.disabled = false;
    allButton.disabled = false;
    cancelButton.hidden = true;
  }
}

function wire() {
  $('btn-export').addEventListener('click', () => void runExport('vault:export', 'logExportStarted'));
  $('btn-export-all').addEventListener('click', () => void runExport('vault:export:all', 'logBulkStart'));
  $('btn-export-cancel').addEventListener('click', () => browser.runtime.sendMessage({ type: 'vault:export:all:cancel' }).catch(() => {}));
  $('btn-options').addEventListener('click', () => browser.runtime.openOptionsPage());

}

async function init() {
  localize();
  wire();
  await Promise.all([refreshFormatsLine(), refreshStatus(), checkHostPermission()]);
  const restored = await restoreCurrentRun();
  if (!restored) logLine(t('emptyLog'));
}

void init();
