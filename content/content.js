/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Content script — injected on demand via scripting.executeScript, never
 * declared statically in the manifest. Answers scrape requests from the
 * background worker and manages the optional floating export button
 * (rendered inside a closed shadow root so page CSS cannot touch it and it
 * cannot touch the page).
 */
(() => {
  'use strict';
  if (globalThis.__veniceVaultContentLoaded) return;
  globalThis.__veniceVaultContentLoaded = true;

  let floatingHost = null;

  /** Run the scraper injected alongside this file. */
  function scrapeNow() {
    if (!globalThis.VeniceVaultScrape) {
      return Promise.reject(new Error('scraper module not injected'));
    }
    return globalThis.VeniceVaultScrape.scrapePage();
  }

  /** Show or hide the floating "Archive with Venice Vault" button. */
  function setFloatingButton(enabled) {
    if (!enabled && floatingHost) {
      floatingHost.remove();
      floatingHost = null;
      return;
    }
    if (!enabled || floatingHost) return;
    const host = document.createElement('div');
    host.id = 'venice-vault-floating-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      'button{position:fixed;right:16px;bottom:16px;z-index:2147483647;border:none;border-radius:8px;' +
      'padding:10px 14px;background:#c2410c;color:#ffffff;font:600 13px system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35)}' +
      'button:hover{background:#9a3109}' +
      'button:focus-visible{outline:2px solid #ffffff;outline-offset:2px}';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Archive with Venice Vault';
    button.addEventListener('click', () => {
      try {
        browser.runtime.sendMessage({ type: 'vault:export' }).catch(() => {});
      } catch {
        // extension is being reloaded/uninstalled; nothing to report to
      }
    });
    shadow.append(style, button);
    document.documentElement.append(host);
    floatingHost = host;
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'vault:scrape') {
      return scrapeNow()
        .then((result) => ({ ok: true, ...result }))
        .catch((e) => ({ ok: false, code: e?.code ?? 'scrape-failed', message: String(e?.message ?? e) }));
    }
    if (message?.type === 'vault:scrape-list') {
      if (!globalThis.VeniceVaultScrape?.scrapeConversationList) {
        return Promise.resolve({ ok: false, message: 'scraper module not injected' });
      }
      return globalThis.VeniceVaultScrape.scrapeConversationList(message.options ?? {})
        .then((result) => ({ ok: true, ...result }))
        .catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
    }
    if (message?.type === 'vault:configure') {
      setFloatingButton(message.floatingButton === true);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
