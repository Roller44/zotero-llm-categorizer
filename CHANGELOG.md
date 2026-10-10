# Changelog

## v1.3.0 — 2026-10-10

### Fixed

- **Duplicate collection creation (systematic twin duplication)** — every
  collection in the library was duplicated with an identical twin under the
  same parent. Root cause: `wireBtn()` in `organizerUI.ts` registered the same
  handler on both the XUL `command` AND `click` events, so a single click on
  "Apply Plan" invoked `onApply` twice concurrently. Each call ran `applyPlan`
  with its own local `pathToID` map, and neither call's newly-created
  collections had committed before the other read the library, so both created
  identical collections for every taxonomy node. Fix: removed the `click`
  listener (XUL `command` fires for both mouse and keyboard activation), added
  a synchronous `applying` re-entrancy guard, and disabled buttons before the
  first `await`.
- **Overly aggressive collision guard blocked legitimate collections** — the
  `findLocalNameCollisions` guard in `planApplier.ts` flagged ANY taxonomy node
  whose leaf name matched an existing collection at a different path, even when
  the full paths were completely different (e.g.
  `MachineLearning/ReinforcementLearning/DeepRL` vs existing
  `MachineLearning/ReinforcementLearn/DeepRL`). This caused 5 collections to be
  skipped and 90 items to fail refile. Fix: the guard now only flags collisions
  when the leaf name matches under the SAME parent path (a true duplicate), not
  under different parents.
- **`buildExistingPath` produced wrong paths for stale collections** — when a
  collection's parent was missing from the `existingByID` map, the function
  returned a partial path (just the leaf name) instead of an empty string,
  which could cause the create loop to miss existing collections and create
  duplicates. Fix: returns `""` on missing parent so the caller skips the
  stale collection.
- **Duplicate paths within a single assignment** — `validateAssignments` in
  `planValidator.ts` did not deduplicate `collectionPaths` within one
  assignment, so the LLM could return the same path twice. Fix: added a
  `seenPaths` Set that drops duplicate valid paths.

### Added

- **Comprehensive documentation directory** (`docs/`) — 17 markdown files
  covering architecture, plugin lifecycle, every module, utilities, tests, and
  a structured API reference. Each function description uses API-style blocks
  (TypeScript signature, parameter table, return type, exceptions) with
  preserved prose context (design decisions, bug history, how-to-extend notes).

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
