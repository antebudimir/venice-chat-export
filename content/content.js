/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Content script — injected on demand via scripting.executeScript, never
 * declared statically in the manifest. Answers scrape requests from the
 * background worker and manages the optional floating button (rendered
 * inside a closed shadow root so page CSS cannot touch it and it cannot
 * touch the page).
 *
 * v0.4.0: the floating button is draggable (pointer events, clamped to the
 * viewport) and its position persists in storage.local, so it survives
 * page loads and restarts. Default position is raised above Venice's
 * composer so it cannot cover the conversation-mode controls.
 */
(() => {
  'use strict';
  if (globalThis.__veniceChatExportContentLoaded) return;
  globalThis.__veniceChatExportContentLoaded = true;

  let floatingHost = null;
  const VV_VERSION = browser.runtime.getManifest().version;
  const POSITION_KEY = 'chatExport:floatingButtonPos';
  const DEFAULT_POSITION = { right: 16, bottom: 150 };

  /** Run the scraper injected alongside this file. */
  function scrapeNow() {
    if (!globalThis.VeniceChatExportScrape) {
      return Promise.reject(new Error('scraper module not injected'));
    }
    return globalThis.VeniceChatExportScrape.scrapePage();
  }

  /** Clamp a stored/dragged {right,bottom} offset to the current viewport. */
  function clampPosition(pos) {
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - margin - 220);
    const maxY = Math.max(margin, window.innerHeight - margin - 40);
    return {
      right: Math.min(Math.max(margin, Math.round(Number(pos.right) || DEFAULT_POSITION.right)), maxX),
      bottom: Math.min(Math.max(margin, Math.round(Number(pos.bottom) || DEFAULT_POSITION.bottom)), maxY),
    };
  }

  function applyPosition(button, pos) {
    const clamped = clampPosition(pos);
    button.style.right = `${clamped.right}px`;
    button.style.bottom = `${clamped.bottom}px`;
    button.style.left = 'auto';
    button.style.top = 'auto';
  }

  function loadPosition(button) {
    try {
      browser.storage.local.get(POSITION_KEY)
        .then((stored) => applyPosition(button, stored[POSITION_KEY] ?? DEFAULT_POSITION))
        .catch(() => applyPosition(button, DEFAULT_POSITION));
    } catch {
      applyPosition(button, DEFAULT_POSITION);
    }
  }

  function persistPosition(pos) {
    try {
      browser.storage.local.set({ [POSITION_KEY]: clampPosition(pos) }).catch(() => {});
    } catch {
      // storage hiccup — position simply is not persisted
    }
  }

  /**
   * Drag handling: pointer capture on the button, live repositioning, and
   * persistence on release. If the pointer moved more than a few pixels the
   * trailing click is suppressed so a drag never triggers an export.
   */
  function makeDraggable(button, shadow) {
    let dragged = false;
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = button.getBoundingClientRect();
      const startRight = window.innerWidth - rect.right;
      const startBottom = window.innerHeight - rect.bottom;
      dragged = false;
      try { button.setPointerCapture(event.pointerId); } catch { /* no capture support */ }
      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragged && Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
        if (!dragged) return;
        applyPosition(button, { right: startRight - dx, bottom: startBottom - dy });
      };
      const onUp = (upEvent) => {
        button.removeEventListener('pointermove', onMove);
        button.removeEventListener('pointerup', onUp);
        try { button.releasePointerCapture(upEvent.pointerId); } catch { /* already released */ }
        if (dragged) {
          const rect = button.getBoundingClientRect();
          persistPosition({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom });
          // swallow the click that trails a drag
          shadow.addEventListener('click', (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        }
      };
      button.addEventListener('pointermove', onMove);
      button.addEventListener('pointerup', onUp);
    });
  }

  /** Show or hide the floating "Archive with Venice Chat Export" button. */
  function setFloatingButton(enabled) {
    if (!enabled && floatingHost) {
      floatingHost.remove();
      floatingHost = null;
      return;
    }
    if (!enabled || floatingHost) return;
    const host = document.createElement('div');
    host.id = 'venice-chat-export-floating-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      'button{position:fixed;right:16px;bottom:150px;z-index:2147483647;border:none;border-radius:8px;' +
      'padding:10px 14px;background:#c2410c;color:#ffffff;font:600 13px system-ui,sans-serif;cursor:grab;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);touch-action:none}' +
      'button:active{cursor:grabbing}' +
      'button:hover{background:#9a3109}' +
      'button:focus-visible{outline:2px solid #ffffff;outline-offset:2px}';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Archive with Venice Chat Export';
    button.addEventListener('click', () => {
      try {
        browser.runtime.sendMessage({ type: 'chatExport:export' }).catch(() => {});
      } catch {
        // extension is being reloaded/uninstalled; nothing to report to
      }
    });
    makeDraggable(button, shadow);
    shadow.append(style, button);
    document.documentElement.append(host);
    floatingHost = host;
    loadPosition(button);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'chatExport:scrape') {
      return scrapeNow()
        .then((result) => ({ ok: true, v: VV_VERSION, ...result }))
        .catch((e) => ({ ok: false, v: VV_VERSION, code: e?.code ?? 'scrape-failed', message: String(e?.message ?? e) }));
    }
    if (message?.type === 'chatExport:scrape-list') {
      // Restore in v0.3.0-era rewrites this handler was accidentally dropped,
      // which broke the bulk export's list step entirely.
      if (!globalThis.VeniceChatExportScrape?.scrapeConversationList) {
        return Promise.resolve({ ok: false, v: VV_VERSION, message: 'scraper module not injected' });
      }
      return globalThis.VeniceChatExportScrape.scrapeConversationList(message.options ?? {})
        .then((result) => ({ ok: true, v: VV_VERSION, ...result }))
        .catch((e) => ({ ok: false, v: VV_VERSION, message: String(e?.message ?? e) }));
    }
    if (message?.type === 'chatExport:configure') {
      setFloatingButton(message.floatingButton === true);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
