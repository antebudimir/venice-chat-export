# Venice Chat Export

v0.3.0. A local-only Firefox extension (MV3) that archives **your own Venice.ai conversations**: exports them to timestamped files in several formats, and re-imports them on another machine with a lineage-aware merge. It uploads nothing and contacts nothing — every byte stays on your machine.

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

CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run lint` on Linux. The extension is developed and tested on Linux with Firefox; other operating systems and browsers are untested and unsupported. Filename sanitization still follows Windows rules on purpose — your own backup drive is NTFS, so exported names must survive it.

## Permissions — rationale

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Read the conversation in the tab you explicitly triggered the export from. No background access to any tab. |
| `scripting` | Inject `lib/scrape.js` + `content/content.js` on demand into that one tab. Nothing is declared statically. |
| `storage` | Keep captures, immutable conversation versions, flagged conflicts, and your options locally. |
| `downloads` | Write export files through the Downloads API (Firefox has no writable picked-folder API — see below). |
| `https://venice.ai/*` (host) | See the URL and inject into venice.ai tabs only. No other host, ever. |

Explicitly **not** requested: `tabs`, `webRequest`, `cookies`, `fileSystem`, `unlimitedStorage`, `alarms`.

## Folder access (removed in v0.3.0)

The archive-folder picker was removed. Reason: Firefox closes extension popups the moment a file dialog opens, which made the popup folder picker dead code — and exports never used it anyway (Firefox has no writable picked-folder API; exports go through the Downloads API).

Imports run from the **Options page** instead (Options → Import files…): the Options page is a real tab and survives file dialogs, so the full inspect → review → commit flow is reliable there.

One Firefox quirk to know: MV3 host permissions (venice.ai access) start OFF on freshly loaded extensions and reset when a temporary add-on is reloaded. The popup warns you about it; the grant button lives on the Options page, where the permission prompt cannot be interrupted.

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
| --- | --- |
| same ID, same hash | unchanged — an occurrence is recorded |
| same ID, earlier ordered message prefix intact, messages appended | strict extension — new immutable version |
| shared opening content without proven identity | prefix — flagged for review |
| shared history diverges, or earlier content changed | branch or edit — flagged; both versions persist |
| unknown ID | added |

**A newer version never overwrites an earlier one — both persist.** Branch conflicts are never auto-resolved; they are stored under review and wait for a deliberate decision. Imports show a **dry-run summary** (added / unchanged / extended / prefix-flagged / branch-conflict) before anything is committed; committed data lands in a namespaced `storage.local` key and can be re-exported.

## Export formats (v0.2.0 — labelled by job)

Each run writes separate timestamped files (default template `venice-{date}T{time}-{title}.{ext}`):

- **JSON (backup)** — canonical, lossless: `{ schemaVersion, exportedAt, source, conversations: [{ id, contentHash, title, createdAt, updatedAt, model, messages: [{ role, content, ts, hash }] }] }`. `null` fields are schema placeholders: the key is known, the source did not expose it.
- **Bundle (vault migration — re-imports into Venice Chat Export, includes lineage)** — single JSON with conversations *plus* version history, occurrence counts, and flagged conflicts. **This is the format to export before an OS reinstall or machine move**; importing it restores lineage, not just conversations. Stored versions are hash-validated on import; invalid entries are skipped and counted, never silently stored.
- **Markdown** — one file per conversation; YAML front-matter (title, dates, model, id, hash), `## Role` headings, fenced code preserved.
- **HTML** — self-contained, no external assets, sanitized, with the canonical JSON embedded for lossless re-import; suitable for archiving/printing.

Default is Bundle only — the one to export before an OS reinstall (it carries the lineage). JSON stays available as a lean option; change the checklist in Options.

Plain text, JSONL, and CSV **export** options were removed in v0.2.0 — but **import still reads them** (and every other v0.1.0 file), so existing archives are not orphaned.

## Import

Imports run from the **Options page** (Options → Import files… — dry-run counts, then Commit).

Accepts `.json`, `.jsonl`, `.md`, `.txt`, `.csv`, `.html` — detected by extension, then by content sniffing. `schemaVersion` is validated; unknown versions are rejected with a clear message. Files that fail to parse are reported individually; the run continues with the rest.

## Diagnostics export (redacted)

Options → *Export redacted diagnostics* writes sizes, counts, schema versions, and problem counts only — **no conversation text, no record IDs, no local paths**. Enforced by a whitelist plus defensive string filtering (`lib/redact.js`) and proven by the probe-assertion tests in `test/redact.test.mjs`. Review the file before sharing it.

## Export all conversations (bulk)

The popup's **Export all conversations** button reads your conversation list on venice.ai, then visits each conversation in a single reusable background tab (navigating from one to the next, re-injecting the scraper per visit since injected scripts do not survive navigation) — sequential, throttled, and **continuing past individual failures** (each failed conversation is logged with its URL and counted). Progress shows `visited / listed`; **Cancel** stops between conversations and keeps everything already scraped — additive, nothing lost.

Limits, stated honestly: this exports what the Venice web app *shows in your conversation list*. Conversations the UI never lists cannot be seen by any scraping approach, so completeness cannot be guaranteed by the extension alone. If Venice offers an official account-data export, keep it as the completeness backstop alongside your Vault bundle.

## Auto-sync

Off by default, it's a *reminder* shown when you open the popup. The extension requests no `alarms` permission and never runs in the background on its own.

## Privacy

See [PRIVACY.md](PRIVACY.md): no data is collected or transmitted; all processing is local.

## Licence

AGPL-3.0-or-later — see [LICENSE](LICENSE). Copyright (C) 2026 Ante Budimir.

## Platform scope

Developed and tested on Linux with Firefox only. Other browsers (Brave, Chrome, …) and other operating systems are untested and unsupported. Filename sanitization still follows Windows rules by design — exported files must survive NTFS/exFAT backup drives regardless of platform.
