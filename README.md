# Venice Vault

v0.2.0. A local-only Firefox extension (MV3) that archives **your own Venice.ai conversations**: exports them to timestamped files in several formats, and re-imports them on another machine with a lineage-aware merge. It uploads nothing and contacts nothing — every byte stays on your machine.

This project is a companion to the [Venice Local Archive](../README.md) toolkit and deliberately shares its vocabulary and safety posture. It is not affiliated with or endorsed by Venice.ai.

## Install (sideload via about:debugging)

1. Build it: `npm install`, then `npm run build` (produces `web-ext-artifacts/venice_vault-0.1.0.zip`), or use the source directory directly.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `manifest.json` (or the built zip).
4. Open a conversation on venice.ai, click the toolbar icon, then **Export now**.

Temporary add-ons are removed when Firefox exits; load again per session, or sign the add-on for persistent install.

## Development

```bash
npm install        # dev-only tooling (web-ext); nothing here ships in the XPI
npm test           # node:test suites for the pure lib/ modules (no mocks)
npm run lint       # web-ext lint — must pass clean
npm run build      # web-ext build — produces the XPI zip
npm run icons      # regenerate icons/*.png (dev-only generator)
```

CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run lint` on Ubuntu, Windows, and macOS. The extension code itself is OS-neutral: `/`-only relative paths, BOM-less UTF-8, `\n` endings, no home-directory or drive-letter assumptions — so a matrix failure indicates a genuine portability bug, not a test quirk.

## Permissions — rationale

| Permission | Why it is needed |
|---|---|
| `activeTab` | Read the conversation in the tab you explicitly triggered the export from. No background access to any tab. |
| `scripting` | Inject `lib/scrape.js` + `content/content.js` on demand into that one tab. Nothing is declared statically. |
| `storage` | Keep captures, immutable conversation versions, flagged conflicts, and your options locally. |
| `downloads` | Write export files through the Downloads API (Firefox has no writable picked-folder API — see below). |
| `https://venice.ai/*` (host) | See the URL and inject into venice.ai tabs only. No other host, ever. |

Explicitly **not** requested: `tabs`, `webRequest`, `cookies`, `fileSystem`, `unlimitedStorage`, `alarms`.

## Folder access — the honest Firefox story

Firefox has no File System Access API (`showDirectoryPicker`), so there is no way to obtain a writable handle to a folder you pick with a file dialog. Venice Vault therefore works in tiers:

1. **Drag-and-drop handle** — if your Firefox exposes `getAsFileSystemHandle()` for a dropped folder, the real `FileSystemDirectoryHandle` is persisted in IndexedDB and re-requested (`queryPermission`/`requestPermission`) on each use. This is the only tier that can write into a chosen folder.
2. **`<input type="file" webkitdirectory>`** — remembers the folder's *File objects* (structured-cloneable, stored in IndexedDB, survives restart) so **re-import** can read them again. This tier is read-only: it does **not** grant a writable folder, and every export still writes through the Downloads API. Stored File objects can become unreadable after a restart or if files move — you get an explicit re-select prompt, never silent failure.
3. **Downloads API** — `browser.downloads.download()` with `conflictAction: 'uniquify'` and timestamped filenames. This is the primary write path on Firefox. Optional per-file "save as" dialogs are available in Options.

Net effect on today's Firefox: exports land in your Downloads folder (or wherever you choose per file), with unique timestamped names so **no run ever replaces an earlier one**. If a write hits `NotAllowedError`/`NotFoundError`, you are told explicitly and asked to re-select — nothing fails silently.

## Safety posture

- **Snapshot before read**: the raw scrape is persisted to local storage *before* any serialization.
- **Never mutate the source**: the page is only ever read; nothing is injected visually except the optional (off-by-default) floating button.
- **Never replace an earlier run**: additive, timestamped output; `uniquify` on collision.
- **Continue past a single failure**: per-conversation and per-format try/catch; failures are logged and counted.
- **Explicit PASS**: a run reports PASS only when every write completed and nothing failed.

## Count vocabulary (verbatim)

Three different counts, never conflated in UI, logs, or summaries:

- **Snapshot file count** — physical files written by one run. It is not a chat count.
- **Conversation count** — top-level conversations in the run. It is not a file or message count.
- **Message count** — child messages within those conversations.

The newest capture is not the whole archive: older immutable runs remain even when the live profile contains fewer records.

## Lineage model

Records carry a stable logical ID plus a content hash (SHA-256 over canonical JSON; the conversation hash digests the ordered per-message hashes). Classification, used verbatim:

| Condition (same logical ID) | Kind |
|---|---|
| same ID, same hash | unchanged — an occurrence is recorded |
| same ID, earlier ordered message prefix intact, messages appended | strict extension — new immutable version |
| shared opening content without proven identity | prefix — flagged for review |
| shared history diverges, or earlier content changed | branch or edit — flagged; both versions persist |
| unknown ID | added |

**A newer version never overwrites an earlier one — both persist.** Branch conflicts are never auto-resolved; they are stored under review and wait for a deliberate decision. Imports show a **dry-run summary** (added / unchanged / extended / prefix-flagged / branch-conflict) before anything is committed; committed data lands in a namespaced `storage.local` key and can be re-exported.

## Export formats (v0.2.0 — labelled by job)

Each run writes separate timestamped files (default template `venice-{date}T{time}-{title}.{ext}`):

- **JSON (backup)** — canonical, lossless: `{ schemaVersion, exportedAt, source, conversations: [{ id, contentHash, title, createdAt, updatedAt, model, messages: [{ role, content, ts, hash }] }] }`. `null` fields are schema placeholders: the key is known, the source did not expose it.
- **Bundle (migration — re-importable, includes lineage)** — single JSON with conversations *plus* version history, occurrence counts, and flagged conflicts. **This is the format to export before an OS reinstall or machine move**; importing it restores lineage, not just conversations. Stored versions are hash-validated on import; invalid entries are skipped and counted, never silently stored.
- **Markdown** — one file per conversation; YAML front-matter (title, dates, model, id, hash), `## Role` headings, fenced code preserved.
- **HTML** — self-contained, no external assets, sanitized, with the canonical JSON embedded for lossless re-import; suitable for archiving/printing.

Default is JSON only; change the checklist in Options.

Plain text, JSONL, and CSV **export** options were removed in v0.2.0 — but **import still reads them** (and every other v0.1.0 file), so existing archives are not orphaned.

## Import

Accepts `.json`, `.jsonl`, `.md`, `.txt`, `.csv`, `.html` — detected by extension, then by content sniffing. `schemaVersion` is validated; unknown versions are rejected with a clear message. Files that fail to parse are reported individually; the run continues with the rest.

## Diagnostics export (redacted)

Options → *Export redacted diagnostics* writes sizes, counts, schema versions, and problem counts only — **no conversation text, no record IDs, no local paths**. Enforced by a whitelist plus defensive string filtering (`lib/redact.js`) and proven by the probe-assertion tests in `test/redact.test.mjs`. Review the file before sharing it.

## Export all conversations (bulk)

The popup's **Export all conversations** button reads your conversation list on venice.ai, then visits each conversation in a single reusable background tab (navigating from one to the next, re-injecting the scraper per visit since injected scripts do not survive navigation) — sequential, throttled, and **continuing past individual failures** (each failed conversation is logged with its URL and counted). Progress shows `visited / listed`; **Cancel** stops between conversations and keeps everything already scraped — additive, nothing lost.

Limits, stated honestly: this exports what the Venice web app *shows in your conversation list*. Conversations the UI never lists cannot be seen by any scraping approach, so completeness cannot be guaranteed by the extension alone. If Venice offers an official account-data export, keep it as the completeness backstop alongside your Vault bundle.

## Auto-sync

Off by default, and honestly named: it is a *reminder* shown when you open the popup. The extension requests no `alarms` permission and never runs in the background on its own.

## Privacy

See [PRIVACY.md](PRIVACY.md): no data is collected or transmitted; all processing is local.

## Licence

AGPL-3.0-or-later — see [LICENSE](LICENSE). Copyright (C) 2026 Ante Budimir.

### Why AGPL

The network clause is dormant for a purely local extension: there is no server to expose source for. It is here for consistency with the author's other projects, and because it closes the hosted-fork loophole: if a server component is ever added (say, a sync relay), anyone offering that service over a network must release its source under the same licence.

## TODO

- **Selector calibration (the one open input):** `lib/scrape.js` selectors are best-effort pending one-time calibration against the live Venice.ai DOM. The matched selector tier is reported to the activity log, so calibration against the real site is a single pass: open a conversation, export, read the logged tier, tighten tier-1/2 selectors if the generic heuristic (tier 3) matched.
- Auto-sync currently reminds via the popup only; revisit if a scheduling permission ever becomes acceptable.
- Remembered-folder re-import scans only top-level picked files (webkitdirectory is not recursive on all platforms).

## Manual testing on macOS / Windows

Developer tests run on Linux (and CI); the following need a human on the target OS:

- [ ] Downloads land in the OS Downloads folder with `uniquify` names; `saveAs` dialog behaves (macOS sheet / Windows dialog).
- [ ] `conflictAction: 'uniquify'` produces non-colliding names on NTFS (case-insensitivity, reserved names) and APFS.
- [ ] Filename sanitizer output is accepted by both filesystems (unicode titles, trailing dots/spaces, >120 chars).
- [ ] Dark/light theme follows the OS setting; contrast reads well on both.
- [ ] Folder re-permission prompt after browser restart (handle tier, where available).
- [ ] Floating button renders and functions on both platforms.
