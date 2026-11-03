/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Options page: floating-button toggle, export formats (default JSON only),
 * filename template, auto-sync interval (off by default; a reminder shown in
 * the popup — this extension has no `alarms` permission and never runs in
 * the background on its own), redacted diagnostics export, and a
 * two-step-confirmed data wipe (destructive action => explicit confirm).
 */

const OPTIONS_KEY = 'vault:options';
const DEFAULT_OPTIONS = {
  formats: ['bundle'],
  floatingButton: false,
  filenameTemplate: 'venice-{date}T{time}-{title}.{ext}',
  askSaveLocation: false,
  autoSyncMinutes: 0,
};

const $ = (id) => document.getElementById(id);
const t = (key, subs) => browser.i18n.getMessage(key, subs) || key;

let clearArmed = null;
let pendingImportFiles = null;
const VENICE_ORIGIN = { origins: ['https://venice.ai/*'] };

/** Apply _locales strings to every data-i18n / data-i18n-aria element. */
function localize() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

/** Show a transient status line (aria-live polite). */
function note(message) {
  $('options-status').textContent = message;
}

/** Read current controls into an options object. */
function readControls() {
  const formats = Array.from($('format-list').querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value);
  return {
    formats: formats.length > 0 ? formats : ['bundle'],
    floatingButton: $('opt-floating').checked,
    filenameTemplate: $('opt-template').value.trim() || DEFAULT_OPTIONS.filenameTemplate,
    askSaveLocation: $('opt-asksave').checked,
    autoSyncMinutes: Number($('opt-autosync').value) || 0,
  };
}

/** Persist options; never leave the page in a silent-unknown state. */
async function save() {
  const options = readControls();
  try {
    await browser.storage.local.set({ [OPTIONS_KEY]: options });
    note(t('savedOptions'));
  } catch (e) {
    note(t('errUnexpected', [String(e?.message ?? e)]));
  }
}

/** Load stored options into the controls. */
async function load() {
  const stored = await browser.storage.local.get(OPTIONS_KEY);
  const options = { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] ?? {}) };
  for (const checkbox of $('format-list').querySelectorAll('input[type=checkbox]')) {
    checkbox.checked = options.formats.includes(checkbox.value);
  }
  $('opt-floating').checked = options.floatingButton === true;
  $('opt-template').value = options.filenameTemplate;
  $('opt-asksave').checked = options.askSaveLocation === true;
  $('opt-autosync').value = String(options.autoSyncMinutes);
}

/** Diagnostics export (redacted: sizes, counts, schema versions, problems). */
async function runDiagnostics() {
  const button = $('btn-diagnostics');
  button.disabled = true;
  note(t('logDiagnosticsStarted'));
  try {
    const result = await browser.runtime.sendMessage({ type: 'vault:diagnostics' });
    if (result?.ok) note(t('logDiagnosticsWritten', [result.filename ?? '']));
    else note(t('logFileFailed', ['diagnostics', result?.error ?? 'unknown']));
  } catch (e) {
    note(t('errUnexpected', [String(e?.message ?? e)]));
  } finally {
    button.disabled = false;
  }
}

/** Two-step destructive confirm: first click arms, second click wipes. */
async function clearData() {
  const button = $('btn-clear');
  if (clearArmed === null) {
    clearArmed = setTimeout(() => {
      clearArmed = null;
      button.textContent = t('btnClearData');
      button.disabled = false;
    }, 5000);
    button.textContent = t('confirmClear');
    note(t('confirmClearNote'));
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  button.textContent = t('btnClearData');
  try {
    await browser.runtime.sendMessage({ type: 'vault:clear-data' });
    note(t('clearedData'));
    await load();
  } catch (e) {
    note(t('errUnexpected', [String(e?.message ?? e)]));
  }
}

/**
 * Import flow (moved from the popup in v0.3.0): Firefox closes extension
 * popups when a file dialog opens, which killed the dry-run before commit.
 * The Options page is a real tab and survives the dialog, so the full
 * inspect -> review -> commit sequence is reliable here. One message route,
 * one owner: the background worker (`vault:import:inspect` / `:commit`) —
 * the same channel diagnostics and clear-data already use.
 */
async function importInspect(fileList) {
  pendingImportFiles = [];
  for (const file of fileList) {
    pendingImportFiles.push({ name: file.name, text: await file.text() });
  }
  if (pendingImportFiles.length === 0) {
    note(t('errNoImportFiles'));
    return;
  }
  note(t('logInspecting', [String(pendingImportFiles.length)]));
  try {
    const report = await browser.runtime.sendMessage({ type: 'vault:import:inspect', files: pendingImportFiles });
    const reviewText = document.getElementById('import-review-text');
    reviewText.textContent = '';
    reviewText.append(t('importDryRunTitle', [String(report.conversationCount), String(report.messageCount)]));
    const counts = [
      ['importAdded', report.report.added],
      ['importUnchanged', report.report.unchanged],
      ['importExtended', report.report.extended],
      ['importPrefix', report.report.prefix],
      ['importBranch', report.report.branch],
    ];
    for (const [key, value] of counts) {
      reviewText.append(document.createElement('br'));
      reviewText.append(t(key, [String(value)]));
    }
    for (const error of report.errors ?? []) {
      reviewText.append(document.createElement('br'));
      reviewText.append(t('importErrorLine', [error.name, error.message]));
    }
    document.getElementById('import-review').hidden = false;
    document.getElementById('btn-import-commit').disabled = report.conversationCount === 0;
    note(t('logInspectDone'));
  } catch (e) {
    note(t('errUnexpected', [String(e?.message ?? e)]));
  }
}

/** Commit the inspected import (still additive; conflicts stay flagged). */
async function importCommit() {
  if (!pendingImportFiles) return;
  document.getElementById('btn-import-commit').disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: 'vault:import:commit', files: pendingImportFiles });
    note(t('logImportCommitted', [String(result.report.added), String(result.report.extended)])
      + ' ' + t('logImportFlaggedNote') + ' ' + t('importStoredNote'));
  } catch (e) {
    note(t('errUnexpected', [String(e?.message ?? e)]));
  } finally {
    document.getElementById('import-review').hidden = true;
    pendingImportFiles = null;
  }
}

/**
 * The reliable grant path: the Options page is a real tab, so Firefox's
 * permission prompt cannot kill it the way it kills the extension popup.
 * The granted state is persistent and visible here at all times.
 */
async function refreshAccess() {
  let granted = true;
  try {
    granted = await browser.permissions.contains(VENICE_ORIGIN);
  } catch {
    granted = true;
  }
  const status = document.getElementById('access-status');
  const button = document.getElementById('btn-access-grant');
  if (granted) {
    status.textContent = t('accessGranted');
    button.hidden = true;
  } else {
    status.textContent = t('accessNotGranted');
    button.disabled = false;
  }
}

/** Request venice.ai access from this tab (survives the prompt). */
async function grantAccess() {
  const button = document.getElementById('btn-access-grant');
  button.disabled = true;
  try {
    const ok = await browser.permissions.request(VENICE_ORIGIN);
    note(ok ? t('grantSuccess') : t('grantFailed'));
  } catch (e) {
    note(t('grantFailed'));
  }
  await refreshAccess();
}

function wireImport() {
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-input').click());
  document.getElementById('import-input').addEventListener('change', (event) => {
    void importInspect(Array.from(event.target.files ?? []));
    event.target.value = '';
  });
  document.getElementById('btn-import-commit').addEventListener('click', () => void importCommit());
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    document.getElementById('import-review').hidden = true;
    pendingImportFiles = null;
  });
}

function wire() {
  for (const input of document.querySelectorAll('input, select')) {
    input.addEventListener('change', () => void save());
  }
  $('opt-template').addEventListener('change', () => void save());
  document.getElementById('btn-access-grant').addEventListener('click', () => void grantAccess());
  void refreshAccess();
  wireImport();
  $('btn-diagnostics').addEventListener('click', () => void runDiagnostics());
  $('btn-clear').addEventListener('click', () => void clearData());
}

async function init() {
  localize();
  wire();
  await load();
}

void init();
