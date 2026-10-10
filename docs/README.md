# Zotero Smart Organizer — Developer Documentation

The **Zotero Smart Organizer** is a Zotero 7+ plugin that uses a Large Language Model to help a researcher tidy a library that has grown out of control. It reads the library's items and existing collections, asks an LLM to **propose a taxonomy** of collections tailored to that library, asks the LLM again to **classify each item** under that taxonomy, and — only after the user inspects and approves the result in a review window — **applies** the plan to the live Zotero library. Every operation is human-in-the-loop and revertible: the LLM never writes to the library directly, and a pre-apply snapshot lets the whole thing be rolled back.

This folder is the developer documentation. Each file below is a deep, implementation-focused dive into one subsystem; this index is the map. Read `01-architecture.md` first, then follow the reading order in §2.

---

## 1. Document Index

| # | Document | One-line description |
|---|----------|----------------------|
| 01 | [01-architecture.md](01-architecture.md) | Top-level overview: purpose, the two-stage pipeline, the four-gate development model, technology stack, module map, and dependency diagram. |
| 02 | [02-plugin-lifecycle.md](02-plugin-lifecycle.md) | Bootstrap → sandbox → `Addon` singleton → `hooks.ts`: how the plugin starts, registers chrome URLs/menus/prefs, and tears down on shutdown. |
| 03 | [03-categorization-pipeline.md](03-categorization-pipeline.md) | The orchestrator `categorizer.ts`: the three sequential stages of `generatePlan()`, the `ProgressUpdate` callback, the reasoning-chunk throttle, and `computeStats`. |
| 04 | [04-library-reading.md](04-library-reading.md) | Gate 2 read path: `libraryReader.ts` (Zotero API), `libraryModel.ts` (pure model + serialization + summary), `collectionTree.ts` (slash-delimited path builder). |
| 05 | [05-llm-client.md](05-llm-client.md) | LLM API layer: `llmRequest.ts` (pure request/response building) and `llmClient.ts` (fetch-based SSE streaming, retry, JSON parsing — why `fetch()` over `Zotero.HTTP.request`). |
| 06 | [06-taxonomy-stage.md](06-taxonomy-stage.md) | Stage 1: `taxonomyStage.ts` samples the library, calls the LLM, validates the JSON taxonomy, and retries on failure. |
| 07 | [07-classification-stage.md](07-classification-stage.md) | Stage 2: `classificationStage.ts` batches items, runs batches concurrently with `mapWithConcurrency`, validates per-batch assignments, and soft-fails hallucinated paths. |
| 08 | [08-plan-validator.md](08-plan-validator.md) | `planValidator.ts`: the pure, never-throwing validators (`extractJson`, `validateTaxonomy`, `validateAssignments`, `flattenTaxonomyPaths`, collision detection) that sit between LLM output and the rest of the pipeline. |
| 09 | [09-plan-applier.md](09-plan-applier.md) | Gate 4 write path: `planApplier.ts` is the only module that mutates the library — creates collections, refiles items, cleans up empties; plus the pure `planCollectionCreation` planner. |
| 10 | [10-revert-snapshot.md](10-revert-snapshot.md) | `revertSnapshot.ts`: the capture/revert safety net — records pre-apply memberships and collection IDs, restores them on user-requested revert. |
| 11 | [11-organizer-ui.md](11-organizer-ui.md) | `organizerUI.ts` + `domHelpers.ts`: the human-review `chrome://` window — generating/plan/applying/reverting states, button wiring, and the chrome-scope gotcha. |
| 12 | [12-preferences.md](12-preferences.md) | The preference pane: `addon/prefs.js` defaults, `preferences.xhtml` markup, and `preferenceScript.ts` runtime wiring plus the "Test connection" button. |
| 13 | [13-prompt-builder.md](13-prompt-builder.md) | `promptBuilder.ts`: the pure prompt-construction layer — system prompts, JSON schema instructions, item serializer, and the three `build*Prompt()` functions. |
| 14 | [14-utilities.md](14-utilities.md) | `src/utils/*`: leaf helpers — `domHelpers.ts` (HTML-namespace elements in XUL), `locale.ts` (Fluent), `prefs.ts`, `window.ts`, `ztoolkit.ts`. |
| 15 | [15-tests.md](15-tests.md) | The Mocha/Chai test suite: two-tier split (pure-logic unit tests under plain Node + one Zotero-integrated smoke test), how to run, coverage matrix, and known limitations. |
| 16 | [16-api-reference.md](16-api-reference.md) | Flat, structured reference for every exported function, type, interface, and constant in the plugin, organized by module. |

---

## 2. Suggested Reading Order for a New Developer

Read top-down: start with the architecture, then the lifecycle, then the pipeline end-to-end, then the individual modules in pipeline order.

1. **[01-architecture.md](01-architecture.md)** — the map. Skim §2 (two-stage pipeline), §3 (four-gate model), §7 (module map), and §8 (dependency diagram) so every later doc has a place to live in your head.
2. **[02-plugin-lifecycle.md](02-plugin-lifecycle.md)** — how the plugin boots, registers its chrome URL/menus/prefs, and tears down. Read this before any module doc, because every module is reached through `hooks.ts`.
3. **[03-categorization-pipeline.md](03-categorization-pipeline.md)** — the orchestrator `categorizer.ts` and the `generatePlan()` flow. This is the spine that the stage docs hang off.
4. **[04-library-reading.md](04-library-reading.md)** — Gate 2's read-only library read; the `LibraryItem[]` it produces is the input to everything downstream.
5. **[05-llm-client.md](05-llm-client.md)** — the LLM API layer (fetch + SSE + retry) that both stages call through.
6. **[06-taxonomy-stage.md](06-taxonomy-stage.md)** — Stage 1 (propose taxonomy).
7. **[07-classification-stage.md](07-classification-stage.md)** — Stage 2 (classify items).
8. **[08-plan-validator.md](08-plan-validator.md)** — the validators that gate LLM output into the pipeline.
9. **[11-organizer-ui.md](11-organizer-ui.md)** — the human review window that consumes the plan.
10. **[09-plan-applier.md](09-plan-applier.md)** — the only module that writes to Zotero.
11. **[10-revert-snapshot.md](10-revert-snapshot.md)** — the safety net that makes the write path reversible.
12. Then the standalone docs as needed: **[13-prompt-builder.md](13-prompt-builder.md)**, **[12-preferences.md](12-preferences.md)**, **[14-utilities.md](14-utilities.md)**, **[15-tests.md](15-tests.md)**.
13. **[16-api-reference.md](16-api-reference.md)** — keep this open as a lookup tab while reading any of the above.

---

## 3. Reading List by Task

Pick the task; read the listed docs in order.

| Task | Read these |
|------|------------|
| **Understand the whole plugin at a high level** | 01 → 03 → 11 |
| **Add a new LLM provider** | 05-llm-client.md → 13-prompt-builder.md → 12-preferences.md |
| **Add or change a prompt / JSON schema instruction** | 13-prompt-builder.md → 06-taxonomy-stage.md (Stage 1) and/or 07-classification-stage.md (Stage 2) → 08-plan-validator.md (the validators must accept what you ask the LLM to emit) |
| **Change what library metadata is read or how items are filtered** | 04-library-reading.md → 13-prompt-builder.md (the serializer) → 03-categorization-pipeline.md (where the read is invoked) |
| **Change batch size, concurrency, or the reasoning-trace throttle** | 07-classification-stage.md (batch/concurrency constants) → 03-categorization-pipeline.md (`REASONING_FLUSH_MS`, and note the stale "Running 3 batches concurrently" detail string to keep in sync) |
| **Tighten or loosen validation of LLM output** | 08-plan-validator.md → 06-taxonomy-stage.md and 07-classification-stage.md (the retry loops that consume `ValidationResult`) |
| **Change what the apply path writes (collections, items, tags)** | 09-plan-applier.md → 10-revert-snapshot.md (the snapshot must capture whatever you mutate so revert still works) → 11-organizer-ui.md (the buttons that trigger apply/revert) |
| **Add a new control to the preference pane** | 12-preferences.md → 02-plugin-lifecycle.md (the `registerPrefs`/`onPrefsEvent` wiring) |
| **Add a new menu item or lifecycle hook** | 02-plugin-lifecycle.md (`registerDebugMenu`, the default-export hook table, and the "extending the lifecycle" section) |
| **Modify the review window's UI or its state machine** | 11-organizer-ui.md → 14-utilities.md (`domHelpers.ts` for HTML-namespace element creation) → 03-categorization-pipeline.md (the `ProgressUpdate` contract the UI subscribes to) |
| **Add or modify a unit test** | 15-tests.md → the doc for the module under test (e.g. 08 for validators, 13 for prompt builders, 04 for `libraryModel`/`collectionTree`) → 16-api-reference.md for exact signatures |
| **Look up a specific function, type, or constant** | 16-api-reference.md (flat per-module reference; `path:line` citations back to source) |
| **Work on the bootstrap, singleton, or shutdown path** | 02-plugin-lifecycle.md → 01-architecture.md (§5 lifecycle, §10 key design decisions) |
| **Understand the shared types (`TaxonomyNode`, `ItemAssignment`, `CategorizationPlan`)** | 03-categorization-pipeline.md (§3 data model) → 16-api-reference.md (module `categorizationTypes`) |

---

## 4. Notes

- The docs cite source locations as `path:line` (e.g. `categorizer.ts:49`); those are clickable in most viewers and resolve against `D:\code\zotero-smart-organizer\`.
- A few docs flag known stale comments or minor bugs in the source (e.g. the `b.count - a.path` comparator noted in `04-library-reading.md`, the stale "20 per call / cap of 3" prose in `07-classification-stage.md`, and the stale "Running 3 batches concurrently" detail string in `03-categorization-pipeline.md`). These are documented as-is; no code change was authorized when the docs were written.
- Where a module has no dedicated doc of its own (the shared types in `categorizationTypes.ts`, the in-memory models in `libraryModel.ts` / `collectionTree.ts`, the orchestrator in `categorizer.ts`, the prompt builder in `promptBuilder.ts`, and `src/utils/*`), it is covered inline in `01-architecture.md` §7 and within the relevant stage/utility docs. `13-prompt-builder.md` and `14-utilities.md` now also cover `promptBuilder.ts` and `src/utils/*` respectively.
