## Test Suite

This document covers the automated test suite for the Zotero Smart Organizer plugin. The suite splits cleanly into two tiers: a **pure-logic unit-test tier** (four files, runnable under plain Node with no Zotero) and a **Zotero-integrated smoke test** (one file, runnable only inside a live Zotero sandbox via `zotero-plugin test`). Together they guard the deterministic core of the categorization pipeline while leaving XUL rendering, preference persistence, and live LLM HTTP behavior to manual verification.

### Table of contents

- [Testing approach](#testing-approach)
- [How to run](#how-to-run)
- [File-by-file reference](#file-by-file-reference)
  - [`test/categorization.test.ts` — Gate 3 prompt builders & plan validators](#testcategorizationtestts--gate-3-prompt-builders--plan-validators)
  - [`test/collectionTree.test.ts` — collection paths & library serialization](#testcollectiontreetestts--collection-paths--library-serialization)
  - [`test/gate4.test.ts` — snapshot serialization & collection-creation planner](#testgate4testts--snapshot-serialization--collection-creation-planner)
  - [`test/llmRequest.test.ts` — LLM request building & response parsing](#testllmrequesttestts--llm-request-building--response-parsing)
  - [`test/startup.test.ts` — Zotero-integrated smoke test](#teststartuptestts--zotero-integrated-smoke-test)
- [Coverage matrix](#coverage-matrix)
- [Known limitations & what is NOT tested](#known-limitations--what-is-not-tested)
- [Extending the suite](#extending-the-suite)

---

## Testing approach

### Two tiers, one boundary

The boundary between the two tiers is the **Zotero global**. The four pure-logic files import only dependency-free modules that never touch `Zotero`, `Zotero.*`, the network, or persistent preferences. The fifth file (`startup.test.ts`) is the opposite: it asserts on the live `Zotero[config.addonInstance]` object and therefore requires the full Zotero runtime.

This split is deliberate. Every function that can be expressed as a pure data transformation has been factored into `src/modules/*.ts` so it can be exercised without booting Zotero. The unit tests guard those functions; the smoke test guards the boot path.

### The `globalThis.Zotero?.debug?.()` guard pattern

The pure modules log diagnostic output via `globalThis.Zotero?.debug?.(...)` rather than calling `Zotero.debug(...)` directly. The optional-chaining chain evaluates to a no-op when `Zotero` is `undefined` — which is exactly the case under `node --test`. This is the single convention that lets the same source files be imported both by Zotero (production) and by plain Node (tests) without conditional imports or shims. The test files do **not** install a `Zotero` stub; they rely on the guard to keep things quiet.

### Node's built-in test runner

The pure-logic tests use Node's built-in test runner (`node:test`) with the strict assert module (`node:assert/strict`). There is no test framework dependency for these four files — no `mocha`, no `chai`, no `jest`. This keeps the test surface minimal and means the only thing required to run them is a recent Node.

TypeScript types are erased at runtime by the `--experimental-strip-types` flag, so the `.ts` files are loaded directly without a separate build step or a transpiler in the loop. The test files import source via relative paths like `../src/modules/planValidator.ts` (e.g. `categorization.test.ts:14`), and Node strips the type annotations on the fly.

### The smoke test uses Mocha + Chai

`test/startup.test.ts` is the exception: it uses `describe`/`it` from Mocha and `assert` from Chai (see `startup.test.ts:1-4`). This is because it is executed by `zotero-plugin test` (the `test` script in `package.json` line 27), which drives the Mocha-based harness that ships inside the Zotero plugin scaffold. The `@types/chai`, `@types/mocha`, `chai`, and `mocha` devDependencies in `package.json` (lines 35-40) exist solely to support this one file.

### What the pure tests will never catch

Because `Zotero` is `undefined` in the unit-test tier, the suite explicitly cannot exercise:

- **XUL/HTML rendering** — the preferences pane, dialogs, and any `createElement` calls against the Zotero document.
- **Preference persistence** — reads/writes through `Zotero.Prefs.set`/`get`.
- **Live LLM HTTP** — `fetch` against OpenAI/Anthropic, retries, timeouts, and the `Gate` orchestration that drives the request loop.
- **The actual application of a plan** — `applyPlan`, `captureSnapshot`, and `revertFromSnapshot` all touch Zotero collection/item APIs and are deliberately excluded (see `gate4.test.ts:8-11`).

These are covered by the manual verification steps recorded in `DEVELOPER_REPORT.md` and by the Zotero-integrated smoke test for the boot path. See [Known limitations](#known-limitations--what-is-not-tested) below.

---

## How to run

### Pure-logic unit tests (no Zotero required)

The header comment in each pure-logic file documents the exact command. To run the four files together:

```sh
node --test --experimental-strip-types test/categorization.test.ts test/collectionTree.test.ts test/gate4.test.ts test/llmRequest.test.ts
```

I ran this exact command during this documentation pass against Node `v24.15.0`. Result:

```
ℹ tests 102
ℹ suites 0
ℹ pass 102
ℹ fail 0
ℹ duration_ms 170.0905
```

All 102 tests across the four pure-logic files pass. (The `startup.test.ts` file is intentionally excluded from this command — it requires Zotero globals and will throw `ReferenceError: Zotero is not defined` if run under plain Node.)

### Zotero-integrated smoke test

```sh
npm test
```

This invokes `zotero-plugin test` (`package.json:27`), which boots a Zotero sandbox and runs the Mocha test that lives in `test/startup.test.ts`. It is the only test that validates the plugin actually loaded. I did not run this command during this documentation pass because it requires a working Zotero install; it is reported as **not run**.

---

## File-by-file reference

### `test/categorization.test.ts`

**Path:** `test/categorization.test.ts` (617 lines)
**Tests declared:** 41 (counted as `test(...)` calls in the source)
**Covers:** Gate 3 — the taxonomy/classification prompt builders and the plan validators.
**Imports:** `promptBuilder.ts`, `planValidator.ts` (types from `categorizationTypes.ts`, `libraryModel.ts`).

The file's header comment (`categorization.test.ts:1-9`) names this as "No-network unit tests for the pure Gate 3 logic" and explicitly states it imports "only dependency-free modules (no Zotero globals, no config, no network)".

#### Fixtures

### fixtureItem

Returns a populated `LibraryItem` with sensible defaults; callers pass a `Partial<LibraryItem>` to override fields. The default fixture is a journalArticle on JSCC/wireless image transmission.

```ts
function fixtureItem(overrides: Partial<LibraryItem> = {}): LibraryItem
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `overrides` | `Partial<LibraryItem>` | No | Field overrides merged over the defaults (default `{}`). |

**Returns:** `LibraryItem` — a populated library item (JSCC journal article).

**Throws:** None.

Defined at `categorization.test.ts:33`.

### fixtureTaxonomy

Returns a two-root `TaxonomyNode[]` fixture used across many tests: `SemanticComm` with a `JSCC/Analog` subtree, and a leaf `ChannelCoding`.

```ts
function fixtureTaxonomy(): TaxonomyNode[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | Takes no parameters. |

**Returns:** `TaxonomyNode[]` — two-root taxonomy tree, the canonical fixture shape for the file.

**Throws:** None.

Defined at `categorization.test.ts:54`.

#### `promptBuilder` tests (`categorization.test.ts:87-148`)

### buildTaxonomyPrompt

Builds the system + user messages for Stage 1 (taxonomy proposal).

```ts
export function buildTaxonomyPrompt(
  sample: LibraryItem[],
  customSystemPrompt?: string,
): { system: string; user: string }
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sample` | `LibraryItem[]` | Yes | Sample items to serialize into the user prompt. |
| `customSystemPrompt` | `string` | No | Optional override for the default system prompt. |

**Returns:** `{ system: string; user: string }` — the system and user messages.

**Throws:** None. (Source: `promptBuilder.ts:171`.)

The user message includes every sample item's serialized form and the schema instruction. Pure, deterministic, no side effects.

| Test | Asserts |
|------|---------|
| `buildTaxonomyPrompt: includes titles and schema instruction` | system prompt mentions "8 to 15 top-level areas" and "Return STRICT JSON"; user prompt includes both paper titles, both `itemId`s, and the "2 sample papers" count. |
| `buildTaxonomyPrompt: includes venue, date, currentTopCollection` | user prompt includes the publication title, date, and `currentTopCollection: SemanticComm`. |
| `buildTaxonomyPrompt: unfiled item shows (unfiled)` | an item with `collectionPaths: []` produces `currentTopCollection: (unfiled)`. |

### buildClassificationPrompt

Builds the system + user messages for Stage 2 (per-item classification).

```ts
export function buildClassificationPrompt(
  batch: LibraryItem[],
  taxonomyPaths: string[],
  customSystemPrompt?: string,
): { system: string; user: string }
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `batch` | `LibraryItem[]` | Yes | Slice of items to classify in this single LLM call. |
| `taxonomyPaths` | `string[]` | Yes | Flat list of every valid path in the proposed taxonomy (produced by `flattenTaxonomyPaths`). |
| `customSystemPrompt` | `string` | No | Optional override for the default system prompt. |

**Returns:** `{ system: string; user: string }` — the system and user messages.

**Throws:** None. (Source: `promptBuilder.ts:206`.)

Pure, deterministic.

| Test | Asserts |
|------|---------|
| `buildClassificationPrompt: includes batch items and taxonomy paths` | system prompt mentions "between 1 and 3 paths" and "Return STRICT JSON"; user prompt lists each taxonomy path on its own `- ` line and reports "3 total". |

### buildRetryPrompt

Builds the corrective retry message appended after the LLM's failed response.

```ts
export function buildRetryPrompt(error: string): {
  system: string;
  user: string;
}
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `error` | `string` | Yes | The validator's human-readable error message. |

**Returns:** `{ system: string; user: string }` — retry system + user messages.

**Throws:** None. (Source: `promptBuilder.ts:247`.)

The retry is sent as a follow-up user message in the SAME conversation, so the LLM retains the original system prompt, the item sample, and its own previous (invalid) output. This lets it fix the JSON in context rather than guessing from a bare error string. Pure.

| Test | Asserts |
|------|---------|
| `buildRetryPrompt: includes the error message and forbids prose` | system prompt mentions "could not be parsed" and "no markdown fences"; user prompt echoes the error and demands "ONLY the JSON". |

### serializeItemForPrompt

Serializes a single item to the compact one-line-per-field form used in both prompts. Missing fields become empty strings.

```ts
export function serializeItemForPrompt(item: LibraryItem): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item` | `LibraryItem` | Yes | The library item to serialize. |

**Returns:** `string` — newline-joined `key: value` lines (`itemId`, `title`, `venue`, `date`, `currentTopCollection`, and `abstract` when `ABSTRACT_BUDGET_CHARS > 0`).

**Throws:** None. (Source: `promptBuilder.ts:143`.)

| Test | Asserts |
|------|---------|
| `serializeItemForPrompt: no abstract when budget is 0` | with a 2000-char abstract, the output contains neither `abstract:` nor `…`. (Documents that `ABSTRACT_BUDGET_CHARS=0` omits the abstract entirely.) |

### TAXONOMY_SAMPLE_LIMIT

```ts
export const TAXONOMY_SAMPLE_LIMIT = 40;
```

Maximum number of sample items fed to the taxonomy-proposal prompt. Defined at `promptBuilder.ts:23`.

| Test | Asserts |
|------|---------|
| `TAXONOMY_SAMPLE_LIMIT is the documented 40` | `assert.equal(TAXONOMY_SAMPLE_LIMIT, 40)` — a regression guard for the documented sample-size constant. |

#### `validateTaxonomy` tests (`categorization.test.ts:152-332`)

### validateTaxonomy

Validates an LLM-produced taxonomy payload and returns the sanitized `TaxonomyNode[]` on success. Guards the validator that decides whether the LLM's proposed taxonomy is structurally sound before the applier touches any collections.

```ts
export function validateTaxonomy(json: unknown): ValidationResult<TaxonomyNode[]>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `unknown` | Yes | The raw LLM payload: either a `TaxonomyNode[]` array or a `{ taxonomy: [...] }` wrapper. |

**Returns:** `ValidationResult<TaxonomyNode[]>` — `{ ok: true; value: TaxonomyNode[] }` on success, or `{ ok: false; error: string }` on a structural problem. (Type defined at `planValidator.ts:105`.)

**Throws:** None — errors are returned in the result, never thrown. (Source: `planValidator.ts:202`.)

| Test | Outcome & rationale |
|------|---------------------|
| accepts a valid tree | `ok: true`, two roots, correct nested names. |
| accepts the `{taxonomy:[...]}` wrapper form | Some LLMs wrap the array; the validator tolerates both. |
| rejects empty names | `error` matches `/empty or non-string name/`. |
| rejects malformed paths | path `WrongRoot` for a node named `SemanticComm` → `/does not match expected/`. |
| rejects depth > 3 | A four-deep chain `A/B/C/D` → `/exceeds max depth/`. |
| rejects name containing '/' | A node named `A/B` → `/contains a '\/'/` (the path separator cannot appear in a leaf name). |
| rejects duplicate paths | Two children both at `A/B` → `/duplicate taxonomy path/`. |
| rejects non-array, non-wrapper input | `{foo: 1}` → `ok: false`. |
| rejects empty taxonomy | `[]` → `ok: false`. |
| accepts duplicate leaf names with different paths | Two `MACProtocols` leaves under different roots pass. The test's comment (`categorization.test.ts:293-298`) explains *why* this case matters: rejecting legitimate distinct collections "causes the LLM retry cascade to fail (the LLM loses context and produces garbage on retry)." This is a regression test for a real bug. |

### MAX_TAXONOMY_DEPTH

```ts
export const MAX_TAXONOMY_DEPTH = 3;
```

Maximum allowed depth of the taxonomy tree (root / child / grandchild). Defined at `planValidator.ts:110`.

#### `validateAssignments` tests (`categorization.test.ts:336-454`)

### validateAssignments

Validates an LLM-produced classification payload for one batch. Accepts either an array of assignment objects or `{ assignments: [...] }`. `validPaths` is the set of paths that exist in the taxonomy; any assignment path NOT in this set is DROPPED (with the dropped paths recorded so the caller can log a warning), per the work order's "filter, do not throw" rule. If an assignment ends up with zero valid paths, its `confidence` is forced to `"low"` and `collectionPaths` to `[]`. `confidence` is coerced to one of the three allowed values; anything else (including missing) becomes `"low"`.

```ts
export function validateAssignments(
  json: unknown,
  validPaths: Set<string>,
): { ok: true; value: ItemAssignment[]; droppedPaths: string[] } | { ok: false; error: string }
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `unknown` | Yes | Raw LLM payload — a bare `[...]` array or a `{ assignments: [...] }` wrapper. |
| `validPaths` | `Set<string>` | Yes | Set of taxonomy paths considered valid; assignment paths not in this set are dropped and reported. |

**Returns:** A discriminated union: `{ ok: true; value: ItemAssignment[]; droppedPaths: string[] }` on success, or `{ ok: false; error: string }` on a structural problem.

**Throws:** None — errors are returned in the result. (Source: `planValidator.ts:269`.)

| Test | Asserts |
|------|---------|
| accepts valid assignments | Two assignments pass; `droppedPaths` is `[]`; confidence is preserved. |
| accepts bare array form | The validator accepts a bare `[...]` array (no `{assignments:[...]}` wrapper). |
| filters out paths not in validPaths and records them | Invalid paths are stripped from `collectionPaths` and surfaced in `droppedPaths`; confidence stays `high` because at least one valid path remains. |
| zero valid paths -> confidence low and empty paths | When every path is invalid, `collectionPaths` becomes `[]` and confidence is downgraded to `low`. |
| missing confidence -> low | Absent `confidence` defaults to `low`. |
| invalid confidence string -> low | `confidence: "very sure"` is coerced to `low`. |
| rejects non-numeric itemId | `itemId: "abc"` → `ok: false`. |
| rejects non-array collectionPaths | `collectionPaths: "A"` (string) → `ok: false`. |
| rejects non-array payload | `{foo: 1}` → `ok: false`. |

The `droppedPaths` field is a deliberate design choice: rather than silently dropping invalid paths, the validator reports them so the caller can surface a warning to the user.

#### `flattenTaxonomyPaths` tests (`categorization.test.ts:458-477`)

### flattenTaxonomyPaths

Flattens a taxonomy tree into the list of every path it contains (root and leaf, all depths). Order is depth-first, parent-before-child. Pure.

```ts
export function flattenTaxonomyPaths(taxonomy: TaxonomyNode[]): string[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The taxonomy tree to flatten. |

**Returns:** `string[]` — every taxonomy path in depth-first, parent-before-child order.

**Throws:** None. (Source: `planValidator.ts:359`.)

Three tests pin the depth-first, parent-before-child ordering that the applier relies on:

- nested fixture → `["SemanticComm", "SemanticComm/JSCC", "SemanticComm/JSCC/Analog", "ChannelCoding"]`.
- empty taxonomy → `[]`.
- single root → `["Solo"]`.

#### `findExistingNameCollisions` tests (`categorization.test.ts:481-556`)

### findExistingNameCollisions

Detects leaf-name collisions between a proposed taxonomy and the EXISTING library's collection paths — the root cause of the duplicate-collection-name bug.

```ts
export function findExistingNameCollisions(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { taxPath: string; taxLeafName: string; existingPath: string }[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The proposed taxonomy tree. |
| `existingPaths` | `string[]` | Yes | Existing library collection paths (slash-delimited, root-to-leaf). |

**Returns:** `{ taxPath: string; taxLeafName: string; existingPath: string }[]` — list of collisions (empty if none). Each entry names the offending taxonomy path, its leaf name, and the conflicting existing path.

**Throws:** None. Pure: no Zotero globals, no I/O. (Source: `planValidator.ts:403`.)

A collision is a taxonomy node that the applier would have to CREATE (its full path is NOT in `existingPaths`, so `pathToID.get(node.path)` would be undefined) AND whose LEAF name matches an existing collection's leaf name. In `planApplier.applyPlan` such a node would silently create a brand-new same-named collection under a different parent, leaving the library with two distinct collections that share a name but hold different papers.

A taxonomy node whose full path EXACTLY matches an existing path is a REUSE (the applier will reuse the existing collection) and is never reported, even if some other existing collection shares its leaf name — that pre-existing duplicate is not something this apply would create.

These tests guard the helper that detects the **duplicate-name bug**: the applier would create a brand-new `Theory` under `SemanticComm` even when a top-level `Theory` already exists, because Zotero matches collections by name within a parent. The tests document the bug-motivated contract:

| Test | Behavior |
|------|----------|
| detects leaf-name collision at a different path | One collision reported with `taxPath`, `taxLeafName`, `existingPath`. |
| reuse at exact path is NOT a collision | Same-path nodes are reused, not flagged. |
| no collision when leaf name is unique | Empty result. |
| empty existing paths -> no collisions | Empty result. |
| empty taxonomy -> no collisions | Empty result. |
| reports all conflicting existing paths for one leaf | Two existing `Theory` collections both reported against one new `Theory`. |
| detects collision at root level (top-level reuse of existing top-level name) | Same-path top-level node is a reuse, not a collision. |

The first collision test (`categorization.test.ts:481`) carries an explanatory comment naming the bug it guards: "the duplicate-name bug." This is another rule whose existence is motivated by an observed misbehavior in the applier.

#### `extractJson` tests (`categorization.test.ts:560-616`)

### extractJson

Extracts structured JSON from an LLM response that may include surrounding prose or markdown fences. The strategy is: (1) try a direct parse; (2) look for a ```` ```json ```` or ```` ``` ```` fenced block and parse its contents; (3) otherwise find the first balanced `{...}` or `[...]` substring and parse that.

```ts
export function extractJson(text: string): ValidationResult<unknown>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `text` | `string` | Yes | The raw LLM response text. |

**Returns:** `ValidationResult<unknown>` — `{ ok: true; value: unknown }` on a successful parse, or `{ ok: false; error: string }` describing why extraction failed.

**Throws:** None — never throws; failures are returned. (Source: `planValidator.ts:33`.)

Exported so the stage modules share one extraction strategy and so the strategy itself is unit-testable.

Eight tests for the JSON-extraction helper that pulls structured data out of LLM responses that may include prose or code fences:

- bare JSON object, bare JSON array, ```json fenced block, bare ``` fenced block.
- balanced-object extraction from surrounding prose.
- braces inside strings are handled correctly (string contents are not parsed as JSON).
- empty input and prose-only input are rejected with `ok: false`.

---

### `test/collectionTree.test.ts`

**Path:** `test/collectionTree.test.ts` (215 lines)
**Tests declared:** 11
**Covers:** the collection-path builder (`collectionTree.ts`) and the stable library serializer (`libraryModel.ts`).
**Imports:** `collectionTree.ts` (`buildCollectionPath`, `CollectionNode`), `libraryModel.ts` (`serializeLibrary`, `summarizeLibrary`, `LibraryItem`).

The header (`collectionTree.test.ts:1-9`) describes these as "No-network unit tests for the pure collection-path builder and the stable library serializer."

#### `buildCollectionPath` tests (`collectionTree.test.ts:25-77`)

### CollectionNode

A minimal description of a Zotero collection used by `buildCollectionPath`. The `lookup` closure resolves a collection ID to one of these.

```ts
export interface CollectionNode {
  id: number;
  name: string;
  parentID: number | false;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | The collection's Zotero ID. |
| `name` | `string` | The collection's display name. |
| `parentID` | `number \| false` | Parent collection ID, or `false` (or `0`) for a root collection. |

Defined at `collectionTree.ts:11`.

### buildCollectionPath

Builds the full slash-delimited path (e.g. `"SemanticComm/JSCC/Analog"`) for a collection by walking `parentID` from the given collection up to the root, joining names in root → leaf order.

```ts
export function buildCollectionPath(
  collectionID: number,
  lookup: (id: number) => CollectionNode | undefined,
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `collectionID` | `number` | Yes | The collection whose path to build. |
| `lookup` | `(id: number) => CollectionNode \| undefined` | Yes | Resolves a collection ID to a `CollectionNode`. The test passes a `Map`-backed closure instead of touching `Zotero.Collections`. |

**Returns:** `string` — the slash-joined path, or `""` if `lookup(collectionID)` is `undefined` (the collection no longer exists — possible with stale memberships).

**Throws:** `Error` (message matching `/cycle/i`) if a parent cycle is detected. Defensive; should never happen in Zotero, but a corrupted membership graph could otherwise loop forever. (Source: `collectionTree.ts:29`.)

Each test constructs a `Map<number, CollectionNode>` and a `lookup` closure, then asserts on the produced slash-joined path. The `lookup`-as-dependency design is what makes the function testable without Zotero — the test passes a `Map` and a `(id) => nodes.get(id)` closure instead of touching `Zotero.Collections`.

| Test | Asserts |
|------|---------|
| nested path A -> B -> C returns 'A/B/C' | Three-level chain joins correctly. |
| root-level collection returns just its name | A node with `parentID: false` returns its bare name. |
| parentID 0 is treated as root | `parentID: 0` (numeric) is treated identically to `false` (Zotero uses both conventions). |
| missing collection (lookup undefined) returns '' | A lookup miss yields the empty string, not a throw. |
| cycle A -> B -> A throws | A cyclic parent chain throws with a message matching `/cycle/i`. The cycle guard prevents corrupt parent pointers from causing infinite loops. |
| deeper nesting 4 levels | `SemanticComm/JSCC/Analog/Feedback` produced correctly. |

#### `serializeLibrary` tests (`collectionTree.test.ts:101-167`)

### LibraryItem

In-memory representation of a Zotero item used across the pipeline. Defined at `libraryModel.ts:10`.

```ts
export interface LibraryItem {
  id: number;
  key: string;
  itemType: string;
  title: string;
  abstract: string;
  date: string;
  doi: string;
  publicationTitle: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  tags: string[];
  attachmentCount: number;
  collectionPaths: string[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | The Zotero itemID. |
| `key` | `string` | 8-char Zotero key. |
| `itemType` | `string` | `'journalArticle'`, `'preprint'`, `'book'`, etc. |
| `title` | `string` | Item title. |
| `abstract` | `string` | `abstractNote`. |
| `date` | `string` | Raw date string. |
| `doi` | `string` | DOI. |
| `publicationTitle` | `string` | Publication/venue. |
| `creators` | `{ firstName: string; lastName: string; creatorType: string }[]` | Authors. |
| `tags` | `string[]` | Just the tag strings. |
| `attachmentCount` | `number` | Number of attachments. |
| `collectionPaths` | `string[]` | E.g. `["SemanticComm/JSCC/Analog", "PureML/LLM"]`. |

### fixtureItem (collectionTree.test.ts)

A second local fixture builder (separate from the one in `categorization.test.ts`), producing a `LibraryItem` with `Nature`-style defaults; callers pass `Partial<LibraryItem>` overrides.

```ts
function fixtureItem(overrides: Partial<LibraryItem> = {}): LibraryItem
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `overrides` | `Partial<LibraryItem>` | No | Field overrides (default `{}`). |

**Returns:** `LibraryItem` — populated fixture item.

**Throws:** None.

Defined at `collectionTree.test.ts:81`.

### serializeLibrary

Produces a stable JSON serialization (object keys sorted alphabetically, recursively) of the item array. This is what Gate 3 will consume. Does NOT write to disk.

```ts
export function serializeLibrary(items: LibraryItem[]): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | Items to serialize. |

**Returns:** `string` — stable, pretty-printed JSON (2-space indent) with all object keys sorted recursively.

**Throws:** None. (Source: `libraryModel.ts:30`.)

These tests pin the **stability** contract — the same input must produce byte-identical output, which is what makes library snapshots diffable and LLM prompts cacheable.

| Test | Asserts |
|------|---------|
| produces valid JSON with sorted object keys | Parses as an array; top-level keys appear in alphabetical order. |
| contains all expected LibraryItem fields | Verifies the full expected key set (`abstract`, `attachmentCount`, `collectionPaths`, `creators`, `date`, `doi`, `id`, `itemType`, `key`, `publicationTitle`, `tags`, `title`) and several values. |
| is stable (same input -> identical output) | `serializeLibrary(items) === serializeLibrary(items)` byte-for-byte. |
| empty array produces '[]' | Boundary case. |
| nested object keys (creators[0]) are sorted | Sorting is recursive, not just top-level. |

#### `summarizeLibrary` tests (`collectionTree.test.ts:171-214`)

### LibrarySummary

Summary statistics about a `LibraryItem[]`. Defined at `libraryModel.ts:50`.

```ts
export interface LibrarySummary {
  total: number;
  withAbstract: number;
  withDoi: number;
  withTag: number;
  withAttachment: number;
  unfiled: number;
  topCollectionPaths: { path: string; count: number }[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `total` | `number` | Total item count. |
| `withAbstract` | `number` | Items with a non-empty abstract. |
| `withDoi` | `number` | Items with a DOI. |
| `withTag` | `number` | Items with at least one tag. |
| `withAttachment` | `number` | Items with at least one attachment. |
| `unfiled` | `number` | Items in no collection. |
| `topCollectionPaths` | `{ path: string; count: number }[]` | Top 5 collection paths by descending item count. |

### summarizeLibrary

Computes summary statistics from a `LibraryItem[]`. Pure function over the in-memory model — no Zotero globals. Used by the debug entry point so the same logic is testable without a Zotero sandbox.

```ts
export function summarizeLibrary(items: LibraryItem[]): LibrarySummary
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | Items to summarize. |

**Returns:** `LibrarySummary` — counts plus the top 5 collection paths by descending count (ties broken by ascending path).

**Throws:** None. (Source: `libraryModel.ts:65`.)

| Test | Asserts |
|------|---------|
| counts abstract/doi/tag/attachment and unfiled | With four items (one fully populated+filed, one unfiled with no metadata, one unfiled with metadata, one filed), the counts come out `total=4`, `withAbstract=3`, `withDoi=3`, `withTag=3`, `withAttachment=3`, `unfiled=2`. |
| top 5 collection paths by count, sorted desc | Three distinct paths with counts 3/2/1 are returned sorted by descending count. |

---

### `test/gate4.test.ts`

**Path:** `test/gate4.test.ts` (374 lines)
**Tests declared:** 26
**Covers:** Gate 4 — the revert-snapshot serialization round-trip (`revertSnapshot.ts`) and the collection-creation planner (`planApplier.planCollectionCreation`).
**Imports:** `revertSnapshot.ts` (`serializeSnapshot`, `deserializeSnapshot`, `RevertSnapshot`), `planApplier.ts` (`planCollectionCreation`), types from `categorizationTypes.ts`.

The header (`gate4.test.ts:1-13`) is explicit about scope: the Zotero-touching functions (`captureSnapshot`, `revertFromSnapshot`, `applyPlan`) are **NOT** exercised here — they require a live Zotero sandbox and are validated by the manual verification steps in `DEVELOPER_REPORT.md`.

#### Fixtures (`gate4.test.ts:28-69`)

### fixtureTaxonomy (gate4.test.ts)

Same shape as in `categorization.test.ts` (two-root tree: `SemanticComm` with a `JSCC/Analog` subtree, and a leaf `ChannelCoding`).

```ts
function fixtureTaxonomy(): TaxonomyNode[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | Takes no parameters. |

**Returns:** `TaxonomyNode[]` — two-root taxonomy tree.

**Throws:** None.

Defined at `gate4.test.ts:28`.

### fixtureSnapshot

Returns a `RevertSnapshot` with three items (one unfiled, two filed), a `Set<number>` of existing collection IDs, and a fixed ISO timestamp.

```ts
function fixtureSnapshot(): RevertSnapshot
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | Takes no parameters. |

**Returns:** `RevertSnapshot` — fixed snapshot with three items and `existingCollectionIDs = new Set([1, 2, 5, 6, 7])`.

**Throws:** None.

Defined at `gate4.test.ts:59`.

### ItemMembershipSnapshot

One item's collection memberships at snapshot time. Defined at `revertSnapshot.ts:27`.

```ts
export interface ItemMembershipSnapshot {
  itemId: number;
  collectionIDs: number[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | The Zotero itemID. |
| `collectionIDs` | `number[]` | The item's collection IDs at snapshot time. |

### RevertSnapshot

Full revert state. `existingCollectionIDs` distinguishes collections that existed before apply from those created by apply (so revert can delete the new empty ones). Defined at `revertSnapshot.ts:43`.

```ts
export interface RevertSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: Set<number>;
  timestamp: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `items` | `ItemMembershipSnapshot[]` | Per-item memberships at snapshot time. |
| `existingCollectionIDs` | `Set<number>` | Collection IDs that existed before apply. Serialized as a sorted `number[]` on the wire (JSON has no Set); `deserializeSnapshot` rebuilds the Set. |
| `timestamp` | `string` | ISO timestamp of capture. Defaults to `""` if missing on deserialize. |

#### `serializeSnapshot` / `deserializeSnapshot` tests (`gate4.test.ts:73-246`)

### serializeSnapshot

Serializes a `RevertSnapshot` to a stable JSON string. Pure: no Zotero globals, no I/O. The `existingCollectionIDs` Set is emitted as a sorted array so the output is deterministic (useful for tests and for persisting the snapshot to a pref across Zotero restarts).

```ts
export function serializeSnapshot(snapshot: RevertSnapshot): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `snapshot` | `RevertSnapshot` | Yes | The snapshot to serialize. |

**Returns:** `string` — stable, pretty-printed JSON. The `items[].collectionIDs` arrays are copied defensively so later mutation of the source snapshot does not affect the serialized form.

**Throws:** None. (Source: `revertSnapshot.ts:223`.)

### deserializeSnapshot

Parses a `serializeSnapshot` string back into a `RevertSnapshot`. Pure: no Zotero globals, no I/O. Rebuilds the `existingCollectionIDs` Set from the serialized array.

```ts
export function deserializeSnapshot(json: string): RevertSnapshot
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `string` | Yes | The serialized snapshot string. |

**Returns:** `RevertSnapshot` — the reconstructed snapshot, with `existingCollectionIDs` rebuilt as a `Set<number>` and a fresh `collectionIDs` array per item (no shared references into the input).

**Throws:** `SyntaxError` on malformed JSON. `Error` (with messages matching `/not an object/i`, `/items is not an array/i`, `/itemId is not a finite number/i`, `/collectionIDs is not an array/i`, `/collectionIDs\[<i>\] is not a finite number/i`, `/existingCollectionIDs is not an array/i`) on shape mismatches. Missing `timestamp` defaults to `""`. (Source: `revertSnapshot.ts:247`.)

The shape check is defensive: missing/extra fields are tolerated only when they have a safe default; structural mismatches (non-array `items`, non-number IDs) throw. Callers should treat a throw as "no usable snapshot".

| Test | Asserts |
|------|---------|
| round-trip preserves data | `items`, `existingCollectionIDs`, and `timestamp` survive a serialize-then-deserialize cycle. |
| existingCollectionIDs is a sorted array in the JSON | The `Set` is serialized as a sorted array (deterministic output). |
| items collectionIDs are copied (not the same array ref) | Mutating the source after serialization does not affect the deserialized copy — verifies a defensive copy rather than a shared reference. |
| rebuilds a Set for existingCollectionIDs | `restored.existingCollectionIDs instanceof Set` and contains the expected members. |
| handles empty items and empty existingCollectionIDs | Boundary case. |
| handles item with empty collectionIDs (unfiled) | An unfiled item round-trips with `collectionIDs: []`. |
| throws on non-object root | String, null, and number roots each throw `/not an object/i`. |
| throws when items is not an array | `/items is not an array/i`. |
| throws when an item.itemId is non-numeric | `/itemId is not a finite number/i`. |
| throws when an item.collectionIDs is not an array | `/collectionIDs is not an array/i`. |
| throws when a collectionID is non-numeric | `/collectionIDs\[1\] is not a finite number/i` — the error message includes the offending index. |
| throws when existingCollectionIDs is not an array | `/existingCollectionIDs is not an array/i`. |
| throws on malformed JSON | A `SyntaxError` is thrown for non-JSON input. |
| tolerates missing timestamp (defaults to empty string) | A snapshot with no `timestamp` field deserializes to `""`. |
| produces stable, sorted JSON (deterministic) | Same input → identical output. |

The defensive-copy test (`gate4.test.ts:97-112`) is notable: it mutates `snap.items[0].collectionIDs` *after* calling `serializeSnapshot` and verifies the deserialized copy still reflects the pre-mutation state. This guards against a subtle aliasing bug where the snapshot would silently track live mutations.

The strict validation is intentional: a corrupt snapshot would silently corrupt the library on revert, so the deserializer fails fast with a precise message rather than proceeding with garbage.

### json_safe

Identity helper used in the "sorted array" test to make the intent explicit: the snapshot's `existingCollectionIDs` Set is in arbitrary order; the JSON must still be sorted. The function is a no-op pass-through.

```ts
function json_safe(snap: RevertSnapshot): RevertSnapshot
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `snap` | `RevertSnapshot` | Yes | The snapshot to pass through. |

**Returns:** `RevertSnapshot` — the same snapshot, unchanged.

**Throws:** None.

Defined at `gate4.test.ts:371-373`.

#### `planCollectionCreation` tests (`gate4.test.ts:250-362`)

### planCollectionCreation

Given a taxonomy and the set of existing collection paths (slash-delimited, root-to-leaf, matching `TaxonomyNode.path` format), returns which paths need to be created vs which can be reused.

```ts
export function planCollectionCreation(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { toCreate: string[]; toReuse: string[] }
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The proposed taxonomy tree. |
| `existingPaths` | `string[]` | Yes | Existing collection paths; duplicates are deduped via a `Set`. |

**Returns:** `{ toCreate: string[]; toReuse: string[] }` — `toCreate` lists taxonomy paths not in `existingPaths`, `toReuse` lists those that are. Both follow the depth-first, parent-before-child order of `flattenTaxonomyPaths`, so `toCreate` is in dependency order (parents before children).

**Throws:** None. Pure: no Zotero globals, no I/O. (Source: `planApplier.ts:463`.)

The taxonomy is flattened depth-first (parent before child, via `flattenTaxonomyPaths`); a path is "to reuse" if it already exists in `existingPaths`, "to create" otherwise. The returned `toCreate` is in dependency order (parents before children) so a caller creating them in order will always know the parent ID.

These tests guard the planner that decides which collection paths must be created versus reused when applying a taxonomy.

| Test | Asserts |
|------|---------|
| all paths to create when nothing exists | `toCreate` is the full depth-first walk; `toReuse` is empty. |
| all paths to reuse when everything exists | `toCreate` is empty; `toReuse` matches the existing list. |
| mixed create + reuse | With `SemanticComm` and `ChannelCoding` existing, `toReuse` is `["SemanticComm", "ChannelCoding"]` and `toCreate` is `["SemanticComm/JSCC", "SemanticComm/JSCC/Analog"]`. |
| toCreate is in dependency order (parents before children) | Explicit invariant check: every parent path appears in `toCreate` before its child. This is what lets the applier create collections in list order and always know the parent ID by the time it reaches a child. |
| empty taxonomy -> empty create + reuse | Boundary case. |
| existingPaths with extras not in taxonomy are ignored | Extra paths not in the taxonomy are not reused; only taxonomy paths are created/reused. |
| single root -> [path] | Minimal case. |
| single root already exists -> reuse | Minimal reuse case. |
| dedupes if existingPaths contains duplicates | Duplicate entries in `existingPaths` are deduped via a `Set`. |

The dependency-order test (`gate4.test.ts:294`) is the most important invariant in this file: a caller creating collections in `toCreate` order is guaranteed to know the parent's ID before reaching any child, which is what makes sequential creation safe without a topological sort.

---

### `test/llmRequest.test.ts`

**Path:** `test/llmRequest.test.ts` (264 lines)
**Tests declared:** 18
**Covers:** the LLM HTTP request builder, response parser, and endpoint/provider normalization (`llmRequest.ts`).
**Imports:** `llmRequest.ts` (`buildRequest`, `normalizeEndpoint`, `normalizeProvider`, `parseResponse`, `resolveProvider`, `LlmSettings`).

The header (`llmRequest.test.ts:1-8`) states the file verifies "the OpenAI and Anthropic request shapes (headers + body) and the response parser WITHOUT making any network call or requiring a live API key."

#### Fixtures (`llmRequest.test.ts:21-39`)

Two `LlmSettings` constants: `openaiSettings` (pointing at `api.openai.com`, model `gpt-4o-mini`) and `anthropicSettings` (pointing at `api.anthropic.com`, model `claude-3-5-sonnet-20241022`). Both use fake `sk-test-*` API keys and `maxTokens: 16384`, `timeoutSeconds: 300`, `reasoningEffort: "none"`.

### LlmSettings

Settings used to build a request. Defined at `llmRequest.ts:25`.

```ts
export interface LlmSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: Provider;
  maxTokens: number;
  timeoutSeconds: number;
  reasoningEffort: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `endpoint` | `string` | Endpoint URL (full or base). |
| `apiKey` | `string` | API key. |
| `model` | `string` | Model identifier. |
| `provider` | `Provider` | `"auto"`, `"openai"`, or `"anthropic"`. |
| `maxTokens` | `number` | Max output tokens (sent as `max_tokens`). |
| `timeoutSeconds` | `number` | Request timeout in seconds. |
| `reasoningEffort` | `string` | `"none"` (omit), `"low"`, `"medium"`, `"high"`. |

### Provider

```ts
export type Provider = "auto" | "openai" | "anthropic";
```

Effective provider; `"auto"` resolves via endpoint-URL detection. Defined at `llmRequest.ts:23`.

### ChatMessage

```ts
export interface ChatMessage {
  role: ChatRole;
  content: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `role` | `ChatRole` | `"system"`, `"user"`, or `"assistant"`. |
| `content` | `string` | The message text. |

`ChatRole` is `export type ChatRole = "system" | "user" | "assistant";` (`llmRequest.ts:9`).

### ChatOptions

```ts
export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `temperature` | `number` | Optional sampling temperature. |
| `max_tokens` | `number` | Optional override for `settings.maxTokens`. |
| `reasoning_effort` | `string` | OpenAI reasoning-effort parameter. |

### PreparedRequest

```ts
export interface PreparedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  provider: "openai" | "anthropic";
}
```

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | Normalized endpoint URL. |
| `method` | `"POST"` | Always `POST`. |
| `headers` | `Record<string, string>` | Provider-specific headers. |
| `body` | `string` | JSON string request body. |
| `provider` | `"openai" \| "anthropic"` | Resolved provider. |

### ANTHROPIC_API_VERSION

```ts
export const ANTHROPIC_API_VERSION = "2023-06-01";
```

The `anthropic-version` header value sent on every Anthropic request. Defined at `llmRequest.ts:46`.

#### Provider normalization tests (`llmRequest.test.ts:41-73`)

### normalizeProvider

Coerces a raw provider string to a valid `Provider` value: passes through `"openai"` and `"anthropic"`, and falls back to `"auto"` for anything else (including `""` and unknown strings).

```ts
export function normalizeProvider(value: string): Provider
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `value` | `string` | Yes | Raw provider string. |

**Returns:** `Provider` — `"openai"`, `"anthropic"`, or `"auto"` (default).

**Throws:** None. (Source: `llmRequest.ts:48`.)

| Test | Asserts |
|------|---------|
| normalizeProvider accepts valid values and defaults to auto | `openai`/`anthropic`/`auto` pass through; `"garbage"` and `""` both fall back to `"auto"`. |

### resolveProvider

Resolves the effective provider, applying the `auto` rule: if `provider` is already `"openai"` or `"anthropic"`, it wins; otherwise (`"auto"`) the endpoint URL is inspected — `anthropic.com` in the URL → `"anthropic"`, anything else → `"openai"`.

```ts
export function resolveProvider(
  provider: Provider,
  endpoint: string,
): "openai" | "anthropic"
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `provider` | `Provider` | Yes | The configured provider (an explicit value overrides auto-detection). |
| `endpoint` | `string` | Yes | The endpoint URL, inspected only when `provider === "auto"`. |

**Returns:** `"openai" | "anthropic"` — the resolved provider.

**Throws:** None. (Source: `llmRequest.ts:57`.)

| Test | Asserts |
|------|---------|
| resolveProvider: auto detects anthropic.com in endpoint | An `anthropic.com` URL → `anthropic`; an `openai.com` URL or an unknown proxy → `openai`. |
| resolveProvider: explicit provider overrides auto | An explicit `anthropic`/`openai` wins even when the endpoint URL suggests the other provider. |

#### `buildRequest` tests (`llmRequest.test.ts:75-163`)

### buildRequest

Builds the request object (URL, headers, JSON body) for a chat completion WITHOUT making any network call. This is the unit-testable core.

```ts
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options: ChatOptions = {},
): PreparedRequest
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `messages` | `ChatMessage[]` | Yes | Conversation messages to send. |
| `settings` | `LlmSettings` | Yes | Endpoint, key, model, provider, and token/timeout configuration. |
| `options` | `ChatOptions` | No | Per-call overrides (default `{}`). |

**Returns:** `PreparedRequest` — the normalized URL, `POST` method, provider-specific headers, JSON body string, and resolved provider.

**Throws:** `Error` (matching `/endpoint URL is not configured/i`) when `settings.endpoint` is empty, or (matching `/model is not configured/i`) when `settings.model` is empty. (Source: `llmRequest.ts:97`.)

The provider is resolved via `resolveProvider` and the URL via `normalizeEndpoint`. For Anthropic, the body has `model`, `messages`, `max_tokens` and the headers carry `x-api-key` + `anthropic-version`. For OpenAI, the body has `model`, `messages`, `stream: true`, optional `temperature`, `max_tokens`, and `reasoning_effort`, with a `Bearer` `Authorization` header.

| Test | Asserts |
|------|---------|
| OpenAI shape (headers + body) | `POST`, correct URL, `provider: "openai"`, `Content-Type: application/json`, `Authorization: Bearer ...`, no `x-api-key`/`anthropic-version`; body has `model`, `messages`, `temperature`, `max_tokens`. |
| OpenAI omits temperature when not provided, uses settings max_tokens | `temperature` is absent from the body; `max_tokens` falls back to `settings.maxTokens` (16384). |
| Anthropic shape (headers + body, default max_tokens) | `x-api-key` and `anthropic-version: 2023-06-01` headers set; no `Authorization`; body has `model`, `messages`, `max_tokens`; `temperature` omitted. |
| auto provider routes to anthropic via endpoint URL | With `provider: "auto"` and an Anthropic endpoint, the request is shaped as Anthropic. |
| throws on missing endpoint | `/endpoint URL is not configured/i`. |
| throws on missing model | `/model is not configured/i`. |
| OpenAI base URL is normalized to full chat completions URL | End-to-end: a base URL in `LlmSettings.endpoint` is normalized inside `buildRequest`. |

The header-set assertions are written as both positive checks (`req.headers["x-api-key"] === "sk-ant-..."`) and negative checks (`req.headers["Authorization"] === undefined`), so a regression that added the wrong provider's headers would fail loudly.

#### `parseResponse` tests (`llmRequest.test.ts:164-194`)

### parseResponse

Extracts the assistant text from a provider response body.

```ts
export function parseResponse(
  provider: "openai" | "anthropic",
  responseText: string,
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `provider` | `"openai" \| "anthropic"` | Yes | The provider whose response shape to parse. |
| `responseText` | `string` | Yes | The raw response body text. |

**Returns:** `string` — the assistant's content string. For OpenAI this is `choices[0].message.content`; for Anthropic it is `content[0].text`.

**Throws:** `Error` (matching `/not valid JSON/i`) when the body is not parseable JSON; `Error` (matching `/no choices/i`) for an OpenAI body with no `choices` array; `Error` (matching `/no content/i`) for an Anthropic body with no `content` array. (Source: `llmRequest.ts:165`.)

| Test | Asserts |
|------|---------|
| OpenAI choices[0].message.content | Extracts the content string from the OpenAI shape. |
| Anthropic content[0].text | Extracts the text from the Anthropic shape. |
| throws on invalid JSON | `/not valid JSON/i`. |
| throws on missing choices/content | OpenAI body with no `choices` → `/no choices/i`; Anthropic body with no `content` → `/no content/i`. |

#### `normalizeEndpoint` tests (`llmRequest.test.ts:198-263`)

### normalizeEndpoint

Normalizes the endpoint URL for the given provider. Users often enter a base URL (e.g. `https://api.openai.com/v1` or `https://api.example.com/v1`) rather than the full chat-completions / messages URL. This function appends the correct path when the endpoint doesn't already end with it, so both base URLs and full URLs work.

```ts
export function normalizeEndpoint(
  endpoint: string,
  provider: "openai" | "anthropic",
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `endpoint` | `string` | Yes | The endpoint URL (full or base). Trailing slashes are stripped first. |
| `provider` | `"openai" \| "anthropic"` | Yes | The provider whose URL convention to apply. |

**Returns:** `string` — the normalized endpoint. For OpenAI: appends `/chat/completions` to `/v1` URLs, or `/v1/chat/completions` to bare URLs; full URLs pass through. For Anthropic: appends `/messages` to `/v1` URLs, or `/v1/messages` to bare URLs; full URLs pass through.

**Throws:** None. (Source: `llmRequest.ts:75`.)

| Test | Asserts |
|------|---------|
| OpenAI full URL passes through | A complete `/v1/chat/completions` URL is unchanged. |
| OpenAI base URL gets /chat/completions appended | `https://api.example.com/v1` → `.../v1/chat/completions`. |
| OpenAI bare URL gets /v1/chat/completions appended | `https://my-proxy.example.com` → `.../v1/chat/completions`. |
| trailing slashes are stripped | Both full and base URLs have trailing slashes removed before path appending. |
| Anthropic full URL passes through | A complete `/v1/messages` URL is unchanged. |
| Anthropic base URL gets /messages appended | `https://api.anthropic.com/v1` → `.../v1/messages`. |
| Anthropic bare URL gets /v1/messages appended | `https://my-anthropic-proxy.example.com` → `.../v1/messages`. |

---

### `test/startup.test.ts`

**Path:** `test/startup.test.ts` (8 lines)
**Tests declared:** 1
**Covers:** the plugin boot path — that the addon instance is registered on the live `Zotero` global.
**Imports:** `chai` (`assert`), `config` from `../package.json`.

```ts
import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });
});
```

This is the only test that runs inside Zotero. It uses Mocha's `describe`/`it` global registrations and Chai's `assert.isNotEmpty` to verify that `Zotero[config.addonInstance]` (the addon's root object, registered by the bootstrap) is present and non-empty.

**Why Mocha/Chai and not `node:test`:** `zotero-plugin test` runs discovered specs under Mocha inside the Zotero host, and `chai`/`mocha` are listed as devDependencies in `package.json` for this purpose. The pure-logic tier uses `node:test` because it runs outside Zotero under plain Node.

**Critical caveat:** this file references the bare `Zotero` global. It will throw `ReferenceError: Zotero is not defined` if run under plain Node with `node --test`. It must be executed via `npm test` (`zotero-plugin test`), which boots a Zotero sandbox first. Do not add it to the `node --test` invocation used for the pure-logic files. I did not run this test during this documentation pass; it is reported as **not run**.

---

## Coverage matrix

| Source module | Test file(s) | Tests declared | Covered functions |
|---------------|---------------|----------------|-------------------|
| `src/modules/promptBuilder.ts` | `categorization.test.ts` | 7 | `buildTaxonomyPrompt`, `buildClassificationPrompt`, `buildRetryPrompt`, `serializeItemForPrompt`, `TAXONOMY_SAMPLE_LIMIT` |
| `src/modules/planValidator.ts` | `categorization.test.ts` | 33 | `validateTaxonomy`, `validateAssignments`, `flattenTaxonomyPaths`, `findExistingNameCollisions`, `extractJson` |
| `src/modules/collectionTree.ts` | `collectionTree.test.ts` | 6 | `buildCollectionPath` |
| `src/modules/libraryModel.ts` | `collectionTree.test.ts` | 5 | `serializeLibrary`, `summarizeLibrary` |
| `src/modules/revertSnapshot.ts` | `gate4.test.ts` | 15 | `serializeSnapshot`, `deserializeSnapshot` |
| `src/modules/planApplier.ts` | `gate4.test.ts` | 9 | `planCollectionCreation` |
| `src/modules/llmRequest.ts` | `llmRequest.test.ts` | 18 | `buildRequest`, `parseResponse`, `normalizeEndpoint`, `normalizeProvider`, `resolveProvider` |
| Bootstrap (addon root) | `startup.test.ts` | 1 | `Zotero[config.addonInstance]` registration |

**Totals:** 5 files, 94 pure-logic tests declared + 1 smoke test = 95 tests declared in the source files. Running the four pure-logic files together reports **102 passing** — the authoritative runtime count from the command I ran (`node --test --experimental-strip-types test/categorization.test.ts test/collectionTree.test.ts test/gate4.test.ts test/llmRequest.test.ts` on Node v24.15.0). The discrepancy between 95 and 102 is because some `test(...)` bodies contain multiple `assert.throws` calls against different inputs but are still counted as a single test by the runner; I report both figures rather than picking one.

---

## Known limitations & what is NOT tested

The suite is deliberately scoped to pure logic. The following are **not** covered by automated tests and require manual verification in a live Zotero install:

1. **XUL/HTML rendering.** The preferences pane, dialogs, and any DOM-creating code paths are untested. A change to the XUL markup can break the UI without failing any test.
2. **Preference persistence.** Reads and writes through `Zotero.Prefs.set`/`get` are not exercised. A typo in a preference key will not be caught.
3. **Live LLM HTTP.** `buildRequest` and `parseResponse` are tested for shape, but the actual `fetch` call, timeouts, retries, the `Gate` retry cascade, and provider-specific HTTP error handling are all untested. A 429 from OpenAI or a streaming-response edge case will not be caught.
4. **Plan application.** `applyPlan`, `captureSnapshot`, and `revertFromSnapshot` touch Zotero collection/item APIs and are explicitly out of scope for `gate4.test.ts` (see `gate4.test.ts:8-11`). The pure helpers they call (`serializeSnapshot`, `deserializeSnapshot`, `planCollectionCreation`) are tested, but the Zotero-mutating outer functions are validated by the manual verification steps in `DEVELOPER_REPORT.md`.
5. **The `Gate` orchestration loop.** The retry/escalation state machine that drives multiple LLM rounds is not directly unit-tested; its individual validators and prompt builders are.
6. **Cross-platform behavior.** Tests run on the host's Node; they do not exercise platform-specific Zotero behavior (e.g., file paths, OS-specific dialogs).
7. **End-to-end Gate 1→4 flow.** No test drives the full pipeline from library scan through taxonomy proposal to assignment application. The individual pure stages are covered, but their wiring is not.

When adding code that touches any of the above, add a corresponding manual-verification step to `DEVELOPER_REPORT.md` rather than relying on the automated suite.

---

## Extending the suite

### Adding a new pure-logic test

1. Identify a function in `src/modules/*.ts` that is pure (no `Zotero`, no network, no prefs). If the function you want to test is *not* pure, factor out the pure core first.
2. Add a `test/<area>.test.ts` file with the standard header comment naming the module under test and the run command `node --test --experimental-strip-types test/<area>.test.ts`.
3. Use `import { test } from "node:test"` and `import assert from "node:assert/strict"`. Do not introduce Mocha/Chai in pure-logic files — those are reserved for the Zotero-integrated smoke test.
4. Do not stub `Zotero`. The `globalThis.Zotero?.debug?.()` guard in the source modules is what makes them importable; adding a stub defeats the purpose of the test (which is to prove the modules work without Zotero).
5. Add the new file to the `node --test --experimental-strip-types` invocation in your local run, and verify the total pass count increases.

### Adding a Zotero-integrated test

1. Add a new `describe`/`it` block either to `test/startup.test.ts` or a new file in `test/`.
2. Use Chai (`import { assert } from "chai"`) and Mocha's global `describe`/`it` — these are provided by the `zotero-plugin test` harness.
3. Run with `npm test`. The Zotero sandbox must boot successfully for the test to execute.
4. Keep these tests small and focused on integration concerns (registration, preference wiring, document structure). Heavy logic should live in pure-logic files where it can be tested quickly and deterministically.

### When a test is impossible to write

If a behavior cannot be tested either purely (because it touches Zotero) or via `zotero-plugin test` (because the harness does not expose the needed surface), do not stub a fake passing test. Document the gap in `DEVELOPER_REPORT.md` with a manual-verification checklist, and note the limitation in this file under [Known limitations](#known-limitations--what-is-not-tested).
