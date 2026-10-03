# Changelog

## v1.2.0 — 2026-10-03

### Fixed

- **Fatal error "taxonomy is empty after 2 retries"** — the retry mechanism
  replaced the entire LLM message history with a bare correction prompt,
  discarding the system prompt and the 40-item sample. The LLM on retry had no
  context and produced garbage. Retries now append the bad response + correction
  as a conversation continuation, preserving the original context.
- **Overly strict duplicate-name validator** — the taxonomy validator rejected
  legitimate duplicate leaf names (e.g. "MACProtocols" under both "Wireless" and
  "Wired" parents), which triggered the retry cascade and caused the fatal error
  above. The validator now checks for duplicate *paths* only, not duplicate leaf
  names, since same-named collections under different parents are valid.

### Added

- **Apply progress overlay** — when the user clicks "Apply Plan", the window now
  switches to a progress overlay with a live progress bar and status message
  showing the current phase ("Creating collections… (12/53)", "Refiling items…
  (340/706)", "Cleaning up empty collections…"). This replaces the static
  "Applying plan…" message that made the plugin appear frozen during the
  potentially long apply phase. Action buttons are disabled during apply to
  prevent re-entrancy.

## v1.1.0 — 2026-09-27

### Fixed

- Performance fix: throttled DOM updates + macrotask yield to prevent UI freeze
- Empty collection cleanup fix using `getChildItems(true)`
- Duplicate collection name prevention via prompt constraints + validator + full-path classification
- `UnloadedDataException` fix in cleanup phase

## v1.0.0 — 2026-09-27

Initial release.
