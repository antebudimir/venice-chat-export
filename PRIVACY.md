# Privacy

**No data is collected or transmitted. All processing is local.**

Venice Vault makes no network requests of its own. It reads only the venice.ai conversation page you explicitly export from, and writes only to:

- `browser.storage.local` — captures, immutable conversation versions, flagged lineage conflicts, run summaries, and your options. This never leaves your browser profile.
- IndexedDB — the remembered archive folder grant (directory handle or picked File objects). Local only.
- Your Downloads folder (or a folder you explicitly choose per save) — the export files themselves.

There are no analytics, no telemetry, no remote fonts or scripts, no CDNs. The HTML export embeds no external assets. The optional diagnostics export is deliberately redacted: sizes, counts, schema versions, and problem counts only — no conversation text, no record IDs, no local paths (enforced by `lib/redact.js` and its test suite).

Clearing stored data (Options → *Clear all stored data*) removes everything the extension has kept, and only that: files already written to disk are yours and are not touched.

Copyright (C) 2026 Ante Budimir. Licence: AGPL-3.0-or-later.
