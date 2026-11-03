/* Copyright (C) 2026 Ante Budimir
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Content-side scraper for Venice.ai conversations.
 *
 * Injected on demand as a CLASSIC script (via scripting.executeScript with
 * files), so it must not use import/export — it attaches one namespace,
 * globalThis.VeniceChatExportScrape. DOM-dependent by nature and therefore NOT
 * exercised by the Node test suite; everything computable (hashing,
 * normalization, lineage) lives in pure lib modules. The conversation-ID
 * extraction mirrors conversationIdFromPath in lib/filenames.js.
 *
 * CALIBRATED against the live conversation page (DOM provided by operator):
 * - message list root: div.chat-messages-content[data-empty]
 * - one wrapper per message: div[data-message-id]
 * - user message: [data-testid="user-message"] card
 * - assistant message: wrapper [data-role="assistant"] with
 *   [data-testid="text-chat-message"] inside
 * - message text: the .prose div (excludes action buttons and citations)
 * - timestamps: the ul li span in the message header (time-of-day only)
 * - sidebar (virtualized react-virtuoso list): titles on aria-label, real
 *   scroll container found by ancestor search, nav links rejected
 * - a hydrating page shows a "Loading your private data..." skeleton that
 *   itself matches message selectors — it is filtered out so a half-loaded
 *   page can never be stored as conversation content
 *
 * v0.2.5: the heuristic fallback tiers were REMOVED on purpose. When the
 * calibrated container is missing or unreadable (degraded page, challenge
 * page, navigation still in flight), the old fallbacks matched sidebar and
 * drag-and-drop chrome and stored it as conversations. Now the item fails
 * with the truthful reason and nothing is stored. The bulk crawl adds a
 * second guard: identical message sets across different conversation URLs
 * are rejected as chrome by the background worker.
 */
(() => {
  'use strict';
  if (globalThis.VeniceChatExportScrape) return;

  const CHAT_ROOT_SELECTOR = '.chat-messages-content';
  const MESSAGE_WRAPPER_SELECTOR = '[data-message-id]';
  const LOADING_PATTERN = /(loading your private data|migrating your local database|^(loading|please wait)[.…! \s]*$)/i;
  const BLOCK_TAGS = new Set(['P','DIV','SECTION','ARTICLE','LI','UL','OL','H1','H2','H3','H4','H5','H6','TABLE','TR','PRE','BLOCKQUOTE','FIGURE','FIGCAPTION','HR']);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','SVG','TEMPLATE','BUTTON']);

  /**
   * Layout-independent text extraction. Unlike innerText — which returns
   * nothing for off-screen `content-visibility: auto` elements (Venice puts
   * exactly that style on assistant messages, so scrolled-out replies were
   * previously lost) — this walks the DOM tree over textContent, which works
   * regardless of rendering. Newlines are emitted at block boundaries and
   * <br>, tabs between table cells, so the result stays readable.
   */
  function blockAwareText(node) {
    let out = '';
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) {
        out += child.textContent ?? '';
      } else if (child.nodeType === 1) {
        const tag = String(child.tagName ?? '').toUpperCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (tag === 'BR') { out += '\n'; continue; }
        out += blockAwareText(child);
        if (tag === 'TD' || tag === 'TH') out += '\t';
        else if (BLOCK_TAGS.has(tag)) out += '\n';
      }
    }
    return out;
  }

  /**
   * Conversation id from a URL path. Conversation links are
   * `/chat/classic/<id>` shaped (kind + id), so after the /chat/ prefix TWO
   * segments are required and the last one is the ID. Nav links
   * (`/chat/agent`, `/chat/classic`) must not match. Other prefixes (`/c/`,
   * `/conversation/`, `/thread/`) accept a single ID segment. Mirrors
   * conversationIdFromPath in lib/filenames.js.
   * @param {string} path - A pathname or href path portion.
   * @returns {string|null} The conversation ID, or null for non-conversation paths.
   */
  function conversationIdFromPath(path) {
    const match = String(path ?? '').match(new RegExp('/(c|chat|conversation|thread)s?/([^?#]+)'));
    if (!match) return null;
    const segments = match[2].split('/').filter((segment) => segment !== '');
    const minimumSegments = match[1] === 'chat' ? 2 : 1;
    if (segments.length < minimumSegments) return null;
    const id = segments[segments.length - 1];
    return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
  }

  /** Conversation id from the current page URL; null when not a conversation. */
  function conversationIdFromUrl() {
    return conversationIdFromPath(location.pathname);
  }

  /** Collect conversation links visible in the current DOM. Titles prefer the
   *  aria-label: the visible label node is aria-hidden and can be truncated. */
  function collectConversationLinks() {
    const found = new Map();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') ?? '';
      const id = conversationIdFromPath(href);
      if (!id || found.has(id)) continue;
      const title = (anchor.getAttribute('aria-label') ?? anchor.textContent ?? '').trim().slice(0, 200);
      let url;
      try { url = new URL(href, location.origin).href; } catch { continue; }
      found.set(id, { id, title: title || null, url });
    }
    return [...found.values()];
  }

  /** Stable derived id (unused while the URL carries the id; kept for pages
   *  that may render a conversation without an id-bearing URL). */
  async function derivedId(seed) {
    const data = new TextEncoder().encode(seed);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function detectModel() {
    const selectors = ['[data-model]', '[class*="model-name"]', '[class*="modelName"]', 'meta[name="model"]'];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = el?.getAttribute('data-model') ?? el?.getAttribute('content') ?? el?.textContent;
      if (value && value.trim()) return value.trim().slice(0, 120);
    }
    return null;
  }

  /**
   * CALIBRATED extraction: pull role/content/timestamp out of one
   * [data-message-id] wrapper using the hooks observed on the live site.
   * Loading-placeholder content is skipped entirely so a hydrating page can
   * never be stored as conversation content.
   */
  function extractCalibratedMessage(wrapper, fallbackRoleState) {
    const isUser = wrapper.querySelector('[data-testid="user-message"]');
    const isAssistant = wrapper.querySelector('[data-role="assistant"]') || wrapper.querySelector('[data-testid="text-chat-message"]');
    const prose = wrapper.querySelector('.prose');
    const content = blockAwareText(prose ?? wrapper).replace(/\n{3,}/g, '\n\n').trim();
    if (!content) return null;
    if (LOADING_PATTERN.test(content)) {
      fallbackRoleState.skippedLoading += 1;
      return null;
    }
    let role = isUser ? 'user' : (isAssistant ? 'assistant' : null);
    if (!role) {
      role = fallbackRoleState.fallback;
    }
    fallbackRoleState.fallback = role === 'user' ? 'assistant' : 'user';
    const ts = wrapper.querySelector('ul li span')?.textContent?.trim() ?? null;
    return { role, content, ts };
  }

  /**
   * The message list is windowed: Venice keeps `content-visibility: auto`
   * on assistant wrappers and may only mount messages near the viewport, so
   * a single query sees a scroll-dependent subset (three exports of the same
   * chat produced 19, 30 and 38 messages before this walk existed). Walk the
   * message container's scroll ancestor viewport by viewport, collect
   * message wrappers keyed by their unique data-message-id (dedup — an
   * earlier bug double-counted), and extract afterwards from the stored
   * nodes in first-seen (top-to-bottom) order. blockAwareText works on
   * detached nodes, so wrappers that unmount mid-walk are still extracted.
   * Completeness signal: message count stable for 3 rounds with the
   * container scrolled to its bottom.
   */
  function findMessageScrollContainer(root) {
    let el = root;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  /**
   * Walk + extract the calibrated conversation.
   * @param {{ maxScrolls?: number, scrollDelayMs?: number }} [options]
   * @returns {Promise<{ status: string, messages: Array, warnings: Array, skippedLoading: number }>}
   */
  async function extractCalibratedConversation(options = {}) {
    const root = document.querySelector(CHAT_ROOT_SELECTOR);
    if (!root) return { status: 'not-found' };
    if (root.getAttribute('data-empty') === 'true') return { status: 'empty' };
    const maxScrolls = options.maxScrolls ?? 120;
    const scrollDelayMs = options.scrollDelayMs ?? 200;
    const container = findMessageScrollContainer(root);
    const originalScrollTop = container.scrollTop;
    // Reset to top BEFORE collecting: a previous walk leaves the container
    // scrolled to its bottom, where only the tail window of items is
    // mounted — starting there captures a fraction of the conversation
    // (observed: 21 of 53 on the second run in the same tab).
    container.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, scrollDelayMs));
    const seen = new Map();
    let previousCount = -1;
    let stableRounds = 0;
    let movedOnce = false;
    for (let scroll = 0; scroll <= maxScrolls; scroll++) {
      for (const wrapper of root.querySelectorAll(MESSAGE_WRAPPER_SELECTOR)) {
        const id = wrapper.getAttribute('data-message-id');
        if (id && !seen.has(id)) seen.set(id, wrapper);
      }
      const atEnd = seen.size === previousCount;
      const before = container.scrollTop;
      container.scrollTop = before + Math.max(300, Math.round((container.clientHeight || window.innerHeight) * 0.8));
      const moved = container.scrollTop !== before;
      if (moved) movedOnce = true;
      const atBottom = !moved || container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      if (atEnd && (!moved || atBottom) && movedOnce) {
        stableRounds += 1;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      previousCount = seen.size;
      await new Promise((resolve) => setTimeout(resolve, scrollDelayMs));
    }
    // Restore the user's scroll position only after extraction (wrappers
    // are held by reference; blockAwareText works on detached nodes).
    container.scrollTop = originalScrollTop;
    const warnings = [];
    const messages = [];
    const fallbackRoleState = { fallback: 'user', skippedLoading: 0 };
    for (const wrapper of seen.values()) {
      try {
        const message = extractCalibratedMessage(wrapper, fallbackRoleState);
        if (message) messages.push(message);
      } catch (e) {
        warnings.push({ code: 'message-extract-failed', detail: String(e?.message ?? e).slice(0, 64) });
      }
    }
    return { status: 'ok', messages, warnings, skippedLoading: fallbackRoleState.skippedLoading };
  }

  /**
   * The list is virtualized and the element marked [data-virtuoso-scroller]
   * does not scroll itself in Venice's layout — the real scrolling happens on
   * an ancestor. Find the nearest ancestor of the scroller that actually
   * overflows; fall back to the scroller, then to the document.
   */
  function findListScrollContainer() {
    const scroller = document.querySelector('[data-virtuoso-scroller]');
    let el = scroller?.parentElement ?? null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return scroller;
    return document.scrollingElement ?? document.documentElement;
  }

  /**
   * Resolve the conversation title for the current page, most-specific
   * first: the sidebar entry for the current conversation ID (its aria-label
   * holds the user-visible chat name), then the first NON-EMPTY h1, then
   * document.title (generic site name — last resort), then a placeholder.
   * Empty strings never short-circuit the chain the way a ?? chain would.
   * @returns {string}
   */
  function resolveTitle() {
    const currentId = conversationIdFromUrl();
    if (currentId) {
      for (const anchor of document.querySelectorAll('a[href]')) {
        if (conversationIdFromPath(anchor.getAttribute('href') ?? '') !== currentId) continue;
        const label = (anchor.getAttribute('aria-label') ?? anchor.textContent ?? '').trim();
        if (label) return label.slice(0, 200);
      }
    }
    const candidates = [
      document.querySelector('.chat-header h1')?.innerText,
      document.querySelector('h1')?.innerText,
      document.title,
    ];
    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (value) return value.slice(0, 200);
    }
    return 'Untitled conversation';
  }

  function buildResult(messages, warnings) {
    const title = resolveTitle();
    const timestamps = messages.map((m) => m.ts).filter(Boolean);
    return {
      tier: 1,
      tierDescription: 'chat-messages-content message containers',
      warnings,
      conversations: [{
        id: conversationIdFromPath(location.pathname) ?? 'PENDING',
        title,
        model: detectModel(),
        createdAt: timestamps[0] ?? null,
        updatedAt: timestamps[timestamps.length - 1] ?? null,
        messages,
      }],
    };
  }

  /**
   * Scrape the currently displayed conversation. Calibrated containers only:
   * when they are missing or unreadable the scrape FAILS with the truthful
   * reason — there are no heuristic fallbacks that could store page chrome
   * as conversation content.
   * @returns {Promise<{ tier: number, tierDescription: string, warnings: Array<{ code: string, detail?: string }>, conversations: Array<object> }>}
   * @throws {Error} With code `zero-messages` when nothing usable was found —
   * degraded page, empty conversation, or a page stuck on its loading
   * skeleton. The caller retries until its timeout, then fails the item.
   */
  /**
   * Scrape the currently displayed conversation: walk the message
   * container's scroll range so lazily-mounted messages enter the DOM,
   * extract with the calibrated hooks, and fail with truthful reasons when
   * the container is missing, empty, or still a loading skeleton.
   * @param {{ maxScrolls?: number, scrollDelayMs?: number }} [options]
   * @returns {Promise<{ tier: number, tierDescription: string, warnings: Array<{ code: string, detail?: string }>, conversations: Array<object> }>
   * @throws {Error} With code `zero-messages` on degraded, empty or
   * still-loading pages. No heuristic fallbacks exist by design.
   */
  async function scrapePage(options = {}) {
    const conversation = await extractCalibratedConversation(options);
    if (conversation.status === 'not-found') {
      const err = new Error('conversation container (.chat-messages-content) not found — the page may still be loading, or Venice served a degraded page');
      err.code = 'zero-messages';
      throw err;
    }
    if (conversation.status === 'empty') {
      const err = new Error('this conversation is empty (no messages)');
      err.code = 'zero-messages';
      throw err;
    }
    if (conversation.messages.length === 0) {
      const err = new Error(conversation.skippedLoading > 0
        ? 'the page is still showing its loading placeholder (conversation not rendered yet)'
        : 'no readable messages found in the conversation container');
      err.code = 'zero-messages';
      throw err;
    }
    return buildResult(conversation.messages, conversation.warnings);
  }

  /**
   * Scrape the conversation list by incrementally scrolling its REAL scroll
   * container (see findListScrollContainer — the virtuoso scroller element
   * itself does not scroll in Venice's layout). Completeness signal: highest
   * data-item-index, item count, and scroll position all stable for 3
   * consecutive rounds.
   * @param {{ maxScrolls?: number, scrollDelayMs?: number }} [options]
   * @returns {Promise<{ conversations: Array<{ id: string, title: string|null, url: string }> }>}
   */
  async function scrapeConversationList(options = {}) {
    const maxScrolls = options.maxScrolls ?? 150;
    const scrollDelayMs = options.scrollDelayMs ?? 600;
    const container = findListScrollContainer();
    const originalScrollTop = container.scrollTop;
    // Same reset-to-top rule as the message walk: run 1 leaves the sidebar
    // at the bottom; run 2 must not start there.
    container.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, scrollDelayMs));
    const seen = new Map();
    let highestIndex = -1;
    let previousCount = -1;
    let previousIndex = -1;
    let stableRounds = 0;
    let movedOnce = false;
    for (let scroll = 0; scroll <= maxScrolls; scroll++) {
      for (const item of collectConversationLinks()) {
        if (!seen.has(item.id)) seen.set(item.id, item);
      }
      for (const element of document.querySelectorAll('[data-item-index]')) {
        const index = Number(element.getAttribute('data-item-index'));
        if (Number.isFinite(index) && index > highestIndex) highestIndex = index;
      }
      const before = container.scrollTop;
      container.scrollTop = before + Math.max(200, Math.round((container.clientHeight || window.innerHeight) * 0.8));
      const moved = container.scrollTop !== before;
      if (moved) movedOnce = true;
      const atBottom = !moved || container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      if (seen.size === previousCount && highestIndex === previousIndex && (!moved || atBottom) && movedOnce) {
        stableRounds += 1;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      previousCount = seen.size;
      previousIndex = highestIndex;
      await new Promise((resolve) => setTimeout(resolve, scrollDelayMs));
    }
    container.scrollTop = originalScrollTop;
    return { conversations: [...seen.values()] };
  }

  globalThis.VeniceChatExportScrape = { scrapePage, scrapeConversationList, conversationIdFromPath, collectConversationLinks, resolveTitle };
})();
