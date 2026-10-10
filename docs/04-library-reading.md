# Library Reading and Collection Tree

This document covers how the Zotero Smart Organizer plugin reads the user's Zotero library and reconstructs the existing collection hierarchy. Three modules collaborate:

| Module | Role | Zotero globals? |
|---|---|---|
| `src/modules/libraryReader.ts` | Reads `Zotero.Items` / `Zotero.Collections` and maps them to the in-memory model. | Yes |
| `src/modules/libraryModel.ts` | Pure data model + serialization + summary statistics. | No |
| `src/modules/collectionTree.ts` | Pure helper that walks `parentID` chains to build slash-delimited collection paths. | No |

The split is deliberate: the two pure modules have no Zotero globals and no relative imports, so they can be unit-tested under plain Node without a Zotero sandbox. `libraryReader.ts` is the only module that touches the Zotero JS API, and it is **read-only** — no `saveTx`, no LLM calls, no categorization, no collection creation (`libraryReader.ts:9-13`).

## Overview of the read path

```
readLibrary()                                   (libraryReader.ts:55)
  ├── Zotero.Items.getAll(1)                    user library, libraryID = 1
  ├── for each item:
  │     ├── filter: isRegularItem() && !deleted
  │     ├── resolveCollectionPaths(item)        (libraryReader.ts:94)
  │     │     ├── item.getCollections()         -> number[]
  │     │     ├── for each id:
  │     │     │     lookup(id) via Zotero.Collections.get(id)
  │     │     │     buildCollectionPath(id, lookup)   (collectionTree.ts:29)
  │     │     │       walk parentID -> root, join names with "/"
  │     │     │     try/catch UnloadedDataException -> skip id
  │     └── map to LibraryItem                  (libraryModel.ts:10)
  └── return LibraryItem[]
```

Downstream, Gate 3's categorization stage consumes the resulting `LibraryItem[]`. The same array can be passed to `serializeLibrary` (stable JSON for the LLM prompt) and `summarizeLibrary` (debug/stats).

## `libraryModel.ts` — pure data model

### `LibraryItem`

```ts
export interface LibraryItem {
  id: number;                 // itemID
  key: string;                // 8-char Zotero key
  itemType: string;           // 'journalArticle', 'preprint', 'book', ...
  title: string;
  abstract: string;           // abstractNote
  date: string;               // raw date string
  doi: string;
  publicationTitle: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  tags: string[];             // just the tag strings
  attachmentCount: number;
  collectionPaths: string[];  // e.g. ["SemanticComm/JSCC/Analog", "PureML/LLM"]
}
```
(`libraryModel.ts:10-23`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | The Zotero `itemID`. |
| `key` | `string` | The 8-char Zotero key. |
| `itemType` | `string` | Item type (`'journalArticle'`, `'preprint'`, `'book'`, ...). |
| `title` | `string` | Item title (coerced to `""` if missing). |
| `abstract` | `string` | The `abstractNote` field (coerced to `""` if missing). |
| `date` | `string` | Raw date string (coerced to `""` if missing). |
| `doi` | `string` | DOI (coerced to `""` if missing). |
| `publicationTitle` | `string` | Publication title (coerced to `""` if missing). |
| `creators` | `{ firstName: string; lastName: string; creatorType: string }[]` | Flattened creators; optional fields normalized to `""`. |
| `tags` | `string[]` | Just the tag strings (`t.tag`). |
| `attachmentCount` | `number` | `item.getAttachments().length` — a count, not the IDs. |
| `collectionPaths` | `string[]` | Precomputed slash-delimited paths (e.g. `["SemanticComm/JSCC/Analog", "PureML/LLM"]`). |

Design notes:

- **Strings, not `undefined`.** Every metadata field is coerced to `string` in `libraryReader.ts` via the `field()` helper (`libraryReader.ts:44-46`), so consumers never have to null-check. Missing fields become `""`.
- **Creators are flattened.** `getCreatorsJSON()` returns objects with optional `firstName`/`lastName`/`creatorType`; the model normalizes each to `string` with `?? ""` (`libraryReader.ts:77-81`).
- **Tags are string-only.** The Zotero tag object carries metadata (type, etc.) but only `t.tag` is kept (`libraryReader.ts:82`).
- **`collectionPaths` is precomputed.** Resolved at read time rather than on demand, so the model stays pure downstream.
- **`attachmentCount`** is `item.getAttachments().length` (`libraryReader.ts:83`) — a count, not the attachment IDs, since the categorizer only cares about presence.

### `LibrarySummary`

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
(`libraryModel.ts:50-58`)

| Field | Type | Description |
|-------|------|-------------|
| `total` | `number` | Total item count (`items.length`). |
| `withAbstract` | `number` | Items with a non-empty `abstract`. |
| `withDoi` | `number` | Items with a non-empty `doi`. |
| `withTag` | `number` | Items with at least one tag. |
| `withAttachment` | `number` | Items with `attachmentCount > 0`. |
| `unfiled` | `number` | Items with `collectionPaths.length === 0`. |
| `topCollectionPaths` | `{ path: string; count: number }[]` | Top 5 collection paths by item count. |

Computed by `summarizeLibrary` (below). Used by the debug entry point so the same logic is testable without a Zotero sandbox.

### serializeLibrary

Produces a stable JSON serialization of the item array using `JSON.stringify(items, sortKeyReplacer, 2)`. **Does not write to disk.** This is what Gate 3 consumes.

```ts
export function serializeLibrary(items: LibraryItem[]): string
```
(`libraryModel.ts:30-32`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The in-memory library items to serialize. |

**Returns:** `string` — a stable JSON string (object keys sorted alphabetically, recursively; arrays preserved as-is).

**Throws:** None.

#### `sortKeyReplacer` — stable key ordering

A `JSON.stringify` replacer that, for every plain object, emits its keys in `Object.keys(...).sort()` order, recursively. Arrays are passed through unchanged — order matters for `creators` / `tags` / `collectionPaths`, so they must not be reordered.

```ts
function sortKeyReplacer(_key: string, value: unknown): unknown
```
(`libraryModel.ts:39-48`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `_key` | `string` | Yes | The current key being stringified (unused). |
| `value` | `unknown` | Yes | The current value being stringified. |

**Returns:** `unknown` — a new object with sorted keys if `value` is a plain object, otherwise the value unchanged.

**Throws:** None.

**Why stable serialization?** The serialized form is fed to the LLM in Gate 3 and is also used in test fixtures/golden files. Sorting keys removes a source of nondeterminism (V8 insertion order) so that semantically-equal libraries produce byte-identical JSON.

### summarizeLibrary

Pure single-pass aggregation. For each item it increments counters and, if the item is filed (`collectionPaths.length > 0`), accumulates per-path counts in a `Map<string, number>`. Unfiled items increment `unfiled` and do **not** contribute to `pathCounts`.

```ts
export function summarizeLibrary(items: LibraryItem[]): LibrarySummary
```
(`libraryModel.ts:65-101`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The in-memory library items to summarize. |

**Returns:** `LibrarySummary` — total counts and the top-5 collection paths.

**Throws:** None.

The top-5 collection paths are derived with:

```ts
const topCollectionPaths = [...pathCounts.entries()]
  .map(([path, count]) => ({ path, count }))
  .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  .slice(0, 5);
```
(`libraryModel.ts:87-90`)

Sort is by `count` descending, then path ascending (localeCompare) for a deterministic tie-break, then truncated to 5.

> Note: the comparator `b.count - a.path` (`libraryModel.ts:89`) is a bug — it subtracts a string from a number, which yields `NaN`, so the comparator effectively returns `NaN` and the sort falls back to insertion order on the count-equal case. The intended expression is almost certainly `b.count - a.count`. The `localeCompare` tie-break never actually fires because the first term is `NaN`. This is preserved as-is in the source; flag it if you depend on deterministic top-path ordering. (Not fixed here because no ask authorized a code change.)

## `collectionTree.ts` — pure path builder

### `CollectionNode`

```ts
export interface CollectionNode {
  id: number;
  name: string;
  parentID: number | false;
}
```
(`collectionTree.ts:11-15`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | The collection's `id`. |
| `name` | `string` | The collection's display name. |
| `parentID` | `number \| false` | Parent collection's `id`, or `false`/`0` for a top-level collection. |

A minimal projection of a `Zotero.Collection`. `parentID` is `number | false`:

- `false` (or `0`) marks a top-level collection.
- Any other number is the parent collection's `id`.

The `false` form is what `libraryReader.ts`'s `lookup` produces by normalizing Zotero's `0` (`libraryReader.ts:107`); the `0` form is also accepted by `buildCollectionPath` for robustness (`collectionTree.ts:52`).

### buildCollectionPath

Builds the full slash-delimited path (e.g. `"SemanticComm/JSCC/Analog"`) by walking `parentID` from the given collection up to the root, then joining names in **root → leaf** order.

```ts
export function buildCollectionPath(
  collectionID: number,
  lookup: (id: number) => CollectionNode | undefined,
): string
```
(`collectionTree.ts:29-59`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `collectionID` | `number` | Yes | The collection whose path to build. |
| `lookup` | `(id: number) => CollectionNode \| undefined` | Yes | Resolves a collection ID to a `CollectionNode` (or `undefined` if not found). |

**Returns:** `string` — the slash-delimited path, or `""` if `lookup(collectionID)` is `undefined` (the collection no longer exists — possible with stale memberships).

**Throws:** `Error("Collection path cycle detected at collectionID ...")` if a parent cycle is detected (defensive; should never happen in Zotero, but a corrupted membership graph could otherwise loop forever).

Algorithm:

1. Resolve `start = lookup(collectionID)`. If `undefined`, return `""` — the collection no longer exists, which is possible with stale memberships (`collectionTree.ts:33-36`).
2. Walk the chain with a `visited: Set<number>` guard. At each node:
   - If `visited.has(current.id)`, throw `Error("Collection path cycle detected at collectionID ...")` (`collectionTree.ts:43-47`). This is defensive — Zotero's collection graph is a forest, so a cycle should never occur, but a corrupted membership graph would otherwise loop forever.
   - Mark `current.id` visited.
   - `names.unshift(current.name)` — prepend so the final array is root-first.
   - If `parentID === false || parentID === 0`, break (`collectionTree.ts:51-54`).
   - Otherwise `current = lookup(parentID)`. If the parent lookup returns `undefined`, the loop terminates naturally (the `while (current)` condition), and the path is built from whatever names were collected — i.e. the path stops at the highest reachable ancestor.
3. Return `names.join("/")`.

**Why a `lookup` closure instead of importing `Zotero.Collections`?** This is what makes the module pure and unit-testable. The caller (`libraryReader.ts`) supplies a closure that calls `Zotero.Collections.get(id)`; tests supply a `Map`-backed lookup. The module has no Zotero globals and no relative imports (`collectionTree.ts:1-9`).

**Why the cycle guard?** A naive `while (current)` walk with a buggy or corrupted `parentID` chain (e.g. A→B→A) would loop forever. The `visited` set converts that into a thrown error, which the caller catches and skips (`libraryReader.ts:119-126`).

## `libraryReader.ts` — Zotero API reads

### Re-exports

```ts
export type { LibraryItem, LibrarySummary };
export { serializeLibrary, summarizeLibrary };
```
(`libraryReader.ts:37-38`)

The reader re-exports the pure model so consumers can import everything from one module: `import { readLibrary, serializeLibrary, type LibraryItem } from "./libraryReader"`.

### `USER_LIBRARY_ID` — the implicit `1`

The plugin reads from the **user library only**, hardcoded as `1`:

```ts
const all = (await Zotero.Items.getAll(1)) as Zotero.Item[];
```
(`libraryReader.ts:56`)

| Constant | Value | Description |
|----------|-------|-------------|
| (literal) `1` | `1` | The user's personal library ID. Group libraries have higher numeric IDs. There is no named `USER_LIBRARY_ID` constant in this module; the literal `1` is used directly. |

In Zotero's schema, library ID `1` is the user's personal library (group libraries have higher numeric IDs). The module header documents that this is the user library (`libraryReader.ts:5`). If you need to extend the plugin to group libraries, this is the single call site to parameterize — pass `false` to `getAll` for all libraries, or iterate over `Zotero.Libraries.getAll()` and call `getAll(lib.libraryID)` per library.

### field

Internal helper. Coerces a `getField` result to a string, never throwing on a missing field. Uses `== null` to cover both `undefined` and `null`.

```ts
function field(value: string | undefined | null): string {
  return value == null ? "" : String(value);
}
```
(`libraryReader.ts:44-46`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `value` | `string \| undefined \| null` | Yes | The raw `getField` result to coerce. |

**Returns:** `string` — `""` if `value` is `null`/`undefined`, otherwise `String(value)`.

**Throws:** None.

### readLibrary

The main entry point. Reads all regular, non-trashed items from the user library (libraryID `1`) and maps them to the `LibraryItem` in-memory model. Missing metadata fields are returned as empty strings; an item in no collections has `collectionPaths: []`.

```ts
export async function readLibrary(): Promise<LibraryItem[]>
```
(`libraryReader.ts:55-89`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | Takes no parameters. |

**Returns:** `Promise<LibraryItem[]>` — the in-memory items for Gate 3's categorization stage.

**Throws:** None directly. Errors from `Zotero.Items.getAll(1)` propagate; per-collection resolution failures are caught and skipped inside `resolveCollectionPaths`.

Steps:

1. **Fetch.** `await Zotero.Items.getAll(1)` returns every item in the user library, including attachments, notes, and trashed items — the filtering happens next.
2. **Filter.** For each item, skip unless `item.isRegularItem() && !item.deleted` (`libraryReader.ts:62-64`). This excludes:
   - **Attachments** (`isRegularItem()` is false for `attachment` items).
   - **Notes** (likewise not regular items).
   - **Trashed items** (`item.deleted` is true).
3. **Resolve collections.** `resolveCollectionPaths(item)` (below).
4. **Map.** Build the `LibraryItem` object, calling `field()` on each `getField(...)` result and mapping `getCreatorsJSON()` / `getTags()` / `getAttachments()` as described under `LibraryItem` above.

Order of items in the returned array is whatever `Zotero.Items.getAll(1)` returns — i.e. by `itemID` ascending in current Zotero. The function does not sort; downstream `serializeLibrary` does not reorder the array either (it only sorts object keys, not array elements). If you need a stable item order across runs, sort the result explicitly before serializing.

### resolveCollectionPaths

Resolves an item's collection memberships to full slash-delimited paths. Internal (not exported).

```ts
function resolveCollectionPaths(item: Zotero.Item): string[]
```
(`libraryReader.ts:94-132`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item` | `Zotero.Item` | Yes | The Zotero item whose collection memberships to resolve. |

**Returns:** `string[]` — the slash-delimited paths for the item's collections; `[]` if the item is in no collections. Empty-string results (collection no longer exists) are silently dropped.

**Throws:** None — per-collection failures are caught and skipped.

1. `const collectionIDs = item.getCollections()` — returns `number[]` per the `zotero-types` definition (`getCollections(): number[];`, cited at `libraryReader.ts:14-18`). If empty/absent, return `[]` immediately.
2. Define a `lookup` closure:

   ```ts
   const lookup = (id: number): CollectionNode | undefined => {
     const col = Zotero.Collections.get(id);
     if (!col) return undefined;
     const parentID = col.parentID || false;
     return { id: col.id, name: col.name, parentID };
   };
   ```
   (`libraryReader.ts:100-109`)

   - `Zotero.Collections.get(id)` returns the `Zotero.Collection` (or `undefined`/throws if not loaded).
   - `col.parentID` is typed as `number` on `Zotero.Collection`; a top-level collection reports `0` (falsy). `col.parentID || false` normalizes `0` to `false` for `CollectionNode.parentID`.

3. For each collection ID, call `buildCollectionPath(id, lookup)` inside a `try/catch`:

   ```ts
   try {
     path = buildCollectionPath(id, lookup);
   } catch (e) {
     Zotero.debug(`[SmartOrganizer] resolveCollectionPaths: skipping collection ${id} for item ${item.id}: ${e}`);
     continue;
   }
   ```
   (`libraryReader.ts:118-126`)

   This is the **UnloadedDataException guard** — see below.

4. If `path` is non-empty, push it to `paths`. Empty string (collection no longer exists) is silently dropped.

### The UnloadedDataException guard

`Zotero.Collections.get(id)` can throw `Zotero.Exception.UnloadedDataException` when a collection is registered in the library but its data has not been loaded into memory yet. This is a known Zotero behavior for lazily-loaded data objects.

The guard pattern:

```ts
try {
  path = buildCollectionPath(id, lookup);
} catch (e) {
  Zotero.debug(...);
  continue;
}
```
(`libraryReader.ts:119-126`)

**Why skip rather than rethrow?** A single stale or unloaded membership must not abort the entire library read. If it did, one unloaded collection would prevent Gate 3 from seeing any items — a catastrophic failure mode for a transient, recoverable Zotero state. Skipping the unresolvable ID means:

- The remaining collection IDs for this item still resolve.
- All other items in the library still resolve.
- The item whose membership was skipped simply has one fewer path in `collectionPaths` (it may still appear under its other collections, or become `unfiled` if it had only that one membership).

The exception is logged via `Zotero.debug` with the collection ID and item ID, so the skip is observable in the Zotero debug output. The error message itself (`e`) is interpolated into the log string.

This is the only `try/catch` in the read path; `buildCollectionPath`'s cycle-detected throw and Zotero's `UnloadedDataException` both land here.

## Item filtering logic

The filter is a single line:

```ts
if (!item.isRegularItem() || item.deleted) {
  continue;
}
```
(`libraryReader.ts:62-64`)

| Condition | Excludes | Reason |
|---|---|---|
| `!item.isRegularItem()` | Attachments, notes | These are not papers/books and would pollute the categorizer's input. Attachments are children of regular items; notes are standalone or child notes. |
| `item.deleted` | Trashed items | Trashed items are recoverable in Zotero but should not be categorized. |

What **passes** the filter: `journalArticle`, `preprint`, `book`, `bookSection`, `conferencePaper`, `thesis`, `report`, `webpage`, etc. — any "regular" item type that is not in the trash.

Note that **child notes and child attachments are also excluded** because they are not regular items even when their parent is. The parent regular item's `attachmentCount` is preserved via `item.getAttachments().length` (`libraryReader.ts:83`).

## Interaction with other modules

- **Gate 3 (categorizer).** Consumes the `LibraryItem[]` (typically via `serializeLibrary` for the LLM prompt). The reader is the sole producer of this array.
- **Debug entry point.** Calls `readLibrary()` then `summarizeLibrary()` to print library stats. Because `summarizeLibrary` is pure, the same code path runs in tests without a Zotero sandbox.
- **Collection creation (elsewhere).** The reader does **not** create collections. Collection creation is a write operation and lives in a different module; the reader only reads existing memberships so the categorizer can decide where to file items.

## Extending the reader

### Add a metadata field to `LibraryItem`

1. Add the field to `LibraryItem` in `libraryModel.ts`.
2. In `readLibrary()`, populate it — usually `field(item.getField("fieldName"))` for a string field.
3. If it should appear in the summary, add a counter in `summarizeLibrary` and a field on `LibrarySummary`.
4. `serializeLibrary` needs no change — `sortKeyReplacer` handles new keys automatically (sorted into position).

### Support group libraries

Replace the hardcoded `1` at `libraryReader.ts:56` with a parameter:

```ts
export async function readLibrary(libraryID: number = 1): Promise<LibraryItem[]>
```

and pass it through to `Zotero.Items.getAll(libraryID)`. The rest of the pipeline is library-agnostic. Note that `Zotero.Collections.get(id)` resolves by collection ID globally, so collection path resolution needs no change.

### Change the path delimiter

Edit `names.join("/")` at `collectionTree.ts:58`. The delimiter appears in `LibraryItem.collectionPaths` and in `LibrarySummary.topCollectionPaths`. There is no other hardcoded `"/"` in the read path.

### Handle UnloadedDataException more aggressively

If you would rather retry than skip, replace the `continue` at `libraryReader.ts:125` with a retry that calls `await Zotero.Collections.getAsync(id)` (which loads the collection) before re-running `buildCollectionPath`. Be careful: this introduces `await` into the loop, so `resolveCollectionPaths` would need to become `async` and `readLibrary` would need to `await` it. The current skip-on-throw design is the conservative choice — it never blocks the read on a lazy-load.

## Testability

The two pure modules are the testable surface:

- `libraryModel.test.ts` can construct `LibraryItem[]` literals and assert on `serializeLibrary` / `summarizeLibrary` output, with no mocks.
- `collectionTree.test.ts` can supply a `Map<number, CollectionNode>`-backed `lookup` and assert on paths, cycles, and missing collections.
- `libraryReader.ts` is integration-tested against a real Zotero sandbox — it is intentionally thin so there is little logic to mock.

This separation is the reason `libraryModel.ts` and `collectionTree.ts` have **no relative imports and no Zotero globals** (`libraryModel.ts:1-8`, `collectionTree.ts:1-9`). Adding a Zotero dependency to either would break plain-Node unit tests.
