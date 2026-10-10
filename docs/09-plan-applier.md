# Plan Applier (Write Path)

`src/modules/planApplier.ts` is **Gate 4** of the categorization pipeline: the only module that *mutates* the live Zotero library. It takes a validated `CategorizationPlan` and (1) creates any collections the plan's taxonomy calls for that don't already exist, (2) refiles each assigned item into its target collections, and (3) — in replace mode — deletes collections left empty by the refile. Everything goes through the Zotero JS API with `saveTx()` / `eraseTx()`; no raw SQL is ever issued.

The module is deliberately split into a thin, Zotero-coupled write path (`applyPlan`) and a pure, side-effect-free planner (`planCollectionCreation`, `findLocalNameCollisions`) that is unit-testable under plain Node with no plugin sandbox. The header comment at `planApplier.ts:1-18` states this contract up front.

---

## Module exports

| Export | Kind | Pure? | Purpose |
|---|---|---|---|
| `applyPlan(plan, options)` | async function | No (writes) | Execute the plan against the live library. |
| `planCollectionCreation(taxonomy, existingPaths)` | function | **Yes** | Decide which paths to create vs reuse. |
| `ApplyOptions` | interface | — | Input options for `applyPlan`. |
| `ApplyResult` | interface | — | Output counts + error/collision lists. |
| `ITEM_DELAY_MS` | const (`10`) | — | Per-item save gap in ms. |
| `ItemAssignment` | re-exported type | — | Convenience re-export so UI callers import from one place (`planApplier.ts:631`). |

Type-only imports (`CategorizationPlan`, `ItemAssignment`, `TaxonomyNode` from `./categorizationTypes`, `planApplier.ts:20-24`) are erased by `--experimental-strip-types`, which is what lets `planCollectionCreation` run under plain Node. There are **no relative runtime imports** in this module — every helper that the pure functions need (`flattenPaths`, `leafNameOf`, `findLocalNameCollisions`) is duplicated locally rather than imported from `planValidator` / `collectionTree`. This is a deliberate testability trade-off, called out at `planApplier.ts:492-496`, `513-515`, `537-540`.

---

## `ApplyOptions`

```ts
export interface ApplyOptions {
  replaceExisting: boolean;
  onProgress?: (update: {
    phase: "collections" | "refiling" | "cleanup";
    message: string;
    current: number;
    total: number;
  }) => void;
}
```

| Field | Type | Required | Description |
|------|------|----------|-------------|
| `replaceExisting` | `boolean` | Yes | If `true`, drop each item's prior collection memberships before setting the new ones; if `false`, merge new memberships into the existing ones (additive). No type-level default — callers must pass it explicitly. |
| `onProgress` | `(update: { phase, message, current, total }) => void` | No | Synchronous progress callback for UI updates. Must be cheap; must not touch the DOM directly (the recommended pattern is to set a variable that a separate timer flushes to the DOM). |

- **`replaceExisting`** — *required* boolean. There is no default at the type level; callers must pass it explicitly. The docstring at `planApplier.ts:26-29` calls this "safety rule #3", and the ask for this doc clarifies it is now **mandatory** in the UI flow (the "Replace existing collection memberships" checkbox). When `true`, each item's prior collection memberships are dropped before the new ones are set; when `false`, memberships are merged in (additive).
- **`onProgress`** — optional progress callback invoked synchronously from inside the tight async loops. The contract (`planApplier.ts:33-39`) is explicit: the callback must be cheap. It must **not** touch the DOM directly, because `applyPlan` runs in an unbroken `await` chain; the recommended pattern is to set a variable that a separate timer flushes to the DOM. The callback receives a `phase` discriminator (`"collections"` | `"refiling"` | `"cleanup"`) plus a human-readable `message`, `current`, and `total`, which is exactly what the UI progress bar consumes.

The `phase` strings map 1:1 to the three phases of `applyPlan` (see below).

---

## `ApplyResult`

```ts
export interface ApplyResult {
  collectionsCreated: number;
  itemsRefiled: number;
  collectionsDeleted: number;
  errors: { itemId: number; error: string }[];
  nameCollisions: {
    taxPath: string;
    taxLeafName: string;
    existingPath: string;
  }[];
}
```

| Field | Type | Description |
|------|------|-------------|
| `collectionsCreated` | `number` | Count of new collections created during Phase 1. |
| `itemsRefiled` | `number` | Count of items successfully refiled during Phase 2. |
| `collectionsDeleted` | `number` | Count of pre-existing collections deleted in Phase 3 (replace mode only). |
| `errors` | `{ itemId: number; error: string }[]` | Per-item failures (and synthetic `itemId: -1` collection-level failures). The apply never aborts on a single failure. |
| `nameCollisions` | `{ taxPath: string; taxLeafName: string; existingPath: string }[]` | Taxonomy nodes skipped because their leaf name collides with an existing collection at a different path. Surfaced so the user can edit the taxonomy and re-apply. |

The four scalar counts let the UI render a one-line summary ("12 collections created, 87 items refiled, 4 empty collections deleted"). The two lists exist so the UI can surface **partial-failure detail without losing the successes** (`planApplier.ts:48-58`):

- `errors` — per-item failures (e.g. "item not found or trashed", "collection path could not be resolved"). `itemId` is the Zotero item ID, or `-1` for synthetic errors not tied to a single item (e.g. a collection that failed to create, which transitively dooms every item assigned under it — recorded at `planApplier.ts:255-258` and `218-225`). The apply **never aborts** on a single failure; this is the work-order requirement "Handle errors gracefully — record and continue", referenced at `planApplier.ts:99-100`.
- `nameCollisions` — taxonomy nodes that were *skipped* because their leaf name collides with an existing collection at a different path. Surfaced so the user can edit the taxonomy and re-apply. Each entry has the taxonomy path that would have been created (`taxPath`), the shared leaf name (`taxLeafName`), and the conflicting existing collection's full path (`existingPath`). This is the direct, user-visible artifact of the duplicate-collection-name bug that motivated the collision guard (see §"Collision guard" below).

---

## `applyPlan`

The main entry point (`planApplier.ts:105-450`). Executes a validated `CategorizationPlan` against the live Zotero library: creates missing collections, refiles items, and (in replace mode) deletes newly-empty collections.

```ts
export async function applyPlan(
  plan: CategorizationPlan,
  options: ApplyOptions,
): Promise<ApplyResult>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `plan` | `CategorizationPlan` | Yes | The validated categorization plan (taxonomy + assignments + stats) to apply. |
| `options` | `ApplyOptions` | Yes | Apply options, including the mandatory `replaceExisting` flag and an optional progress callback. |

**Returns:** `Promise<ApplyResult>` — counts of collections created/refiled/deleted plus per-item `errors` and `nameCollisions` lists. Partial success is always returned.

**Throws:** None. All per-item and per-collection failures are caught and recorded in `result.errors` (with `itemId: -1` for synthetic collection-level failures); `applyPlan` does not throw on individual operation failures.

Three phases, in order:

### Phase 1 — Create collections (`planApplier.ts:122-276`)

Goal: produce a `pathToID: Map<string, number>` mapping every taxonomy path (slash-delimited, root-to-leaf, matching `TaxonomyNode.path`) to a numeric Zotero collection ID.

**Step 1.1 — Seed the map with existing collections** (`planApplier.ts:128-161`). All collections in the user library are loaded via `Zotero.Collections.getByLibrary(USER_LIBRARY_ID, true)` (`USER_LIBRARY_ID = 1`, `planApplier.ts:74`, cross-referenced to `libraryReader.ts:56`). Each collection's full path is reconstructed by walking `parentID` chains upward via the local `buildExistingPath` helper (see below). The map is seeded so the applier **reuses** matching collections instead of creating duplicates.

**Twin-collection handling** (`planApplier.ts:137-161`). Zotero permits two distinct collections to share both name *and* parent (a pre-existing data integrity issue the plugin treats as library corruption the user should fix manually). When two existing collections produce the same path, the applier **deterministically keeps the lowest numeric ID** (`Math.min(prior, c.id)`) and logs a warning. The comment at `planApplier.ts:138-142` is explicit that this is a defensive secondary measure: it prevents the applier from silently depending on `getByLibrary`'s iteration order. The dropped twin is *not* deleted; only the kept twin is used for refile.

**Step 1.2 — Collision guard** (`planApplier.ts:163-191`). Before creating anything, the applier runs `findLocalNameCollisions(plan.taxonomy, pathToID)` (see below) to detect taxonomy nodes that would have to be *created* and whose leaf name matches an existing collection at a *different* path. Creating such a node would silently produce a same-named sibling under a different parent — exactly the duplicate-collection-name bug. The full collision list is computed up front so the review UI can surface **all** collisions at once; it is also indexed by `taxPath` into `collisionByTaxPath` for O(1) lookup in the create loop. Every collision is pushed to `nameCollisions` on the result and logged.

**Step 1.3 — Depth-first create loop** (`planApplier.ts:197-272`). The taxonomy is walked depth-first, parents before children, using an explicit stack (initialized in reverse so roots pop in document order). For each node:

1. **Progress**: `onProgress` is fired with phase `"collections"`, `current = collectionsProcessed`, `total = totalPaths` (where `totalPaths = flattenPaths(plan.taxonomy).length`).
2. **Reuse check**: if `pathToID.get(node.path)` is already defined (from the seed step or because an earlier sibling created it), skip creation.
3. **Collision check**: if `collisionByTaxPath.has(node.path)`, *refuse* to create. Push a synthetic error with `itemId: -1` explaining the leaf-name conflict, and **do not** set `pathToID[node.path]`. The comment at `planApplier.ts:226-227` explains the cascade: because the path is never entered into the map, every child node and every item assigned under it will also fail to resolve, which is the intended "fail loud, fail contained" behavior.
4. **Create**: `new Zotero.Collection({ libraryID: USER_LIBRARY_ID, name: node.name, parentID })` (`planApplier.ts:232-237`). `parentID` is `0` for top-level collections (per `collection.d.ts:27`) or the numeric ID resolved from the parent. The collection is saved with `await collection.saveTx()`.
5. **ID capture**: `id = typeof saved === "number" ? saved : collection.id` (`planApplier.ts:242`). This is the **work-order safety rule #2**: *always* use the numeric `id`, *never* `collection.key`. The comment at `planApplier.ts:9` traces this to "the manual session" — string keys turned out to be unreliable for the applier's bookkeeping. `saveTx` returns the new numeric id (`dataObjects.d.ts:233`) but the object is also populated, so the applier prefers whichever is numeric.
6. **Bookkeeping**: `pathToID.set(node.path, id)`, `newCollectionIDs.add(id)`, `collectionsCreated++`.
7. **Failure handling**: if `saveTx` throws, the error is recorded (synthetic, `itemId: -1`) and the path is *not* entered into `pathToID`. Children are still pushed onto the stack — the comment at `planApplier.ts:259-261` notes they may still be creatable if the parent already existed via a different path match.
8. **Recurse**: children are pushed in reverse so they pop in document order, with `parentID` set to the just-resolved `id` (or `false` if the parent failed to resolve — see `planApplier.ts:266-271`).

### Phase 2 — Refile items (`planApplier.ts:278-356`)

For each `ItemAssignment` in `plan.assignments`:

1. **Progress**: `onProgress` is fired only every 10 items (and on the last item) to keep callback overhead low — see the modulo check at `planApplier.ts:286`. Phase is `"refiling"`, `current = itemsProcessed`, `total = totalAssignments`.
2. **Skip empty assignments**: items with `assignment.collectionPaths.length === 0` are silently skipped (`planApplier.ts:296-298`) — they were unfiled in the plan and stay unfiled.
3. **Item lookup**: `Zotero.Items.get(assignment.itemId)`. If the item is missing or trashed, an error is recorded and the item is skipped (`planApplier.ts:299-309`).
4. **Resolve paths to IDs**: each `collectionPath` is looked up in `pathToID`. Misses produce a per-item error ("collection path "…" could not be resolved") but do not abort the loop (`planApplier.ts:312-322`). If *no* paths resolve, the item is left untouched (`planApplier.ts:323-325`).
5. **Merge or replace**:
   - **Replace mode** (`options.replaceExisting === true`): `finalIDs = dedupeSorted(newIDs)`. The old memberships are dropped — `setCollections` overwrites, so the prior `item.getCollections()` is never read. The comment at `planApplier.ts:329` calls this "Destructive".
   - **Additive mode** (`options.replaceExisting === false`): `finalIDs = dedupeSorted([...current, ...newIDs])`, where `current = (item.getCollections() ?? []).slice()` (`planApplier.ts:332-334`). Existing memberships are preserved.
6. **Save**: `item.setCollections(finalIDs); await item.saveTx();`. **Always `saveTx`** — this is **work-order safety rule #1** (no raw SQL, no `save()` without transaction). The comment at `planApplier.ts:7-8` states it outright.
7. **Throttle**: `await delay(ITEM_DELAY_MS)` after every successful save. `ITEM_DELAY_MS = 10` (`planApplier.ts:81`). The comment at `planApplier.ts:77-80` traces this to "the manual `#Organization` session", which learned that saving many items in a tight loop overwhelms Zotero's transaction queue. The 10ms gap is a work-order requirement, not a tunable.
8. **Per-item error capture**: any exception in the loop is caught, logged, and recorded with `itemId` and message; the loop continues (`planApplier.ts:343-351`).

### Phase 3 — Cleanup empty collections (`planApplier.ts:358-435`)

**Only runs when `options.replaceExisting === true`.** In additive mode Phase 3 is skipped entirely (`planApplier.ts:431-435`), because additive mode by definition leaves existing collections populated.

When replace mode is on:

1. **Re-fetch all collections** with `Zotero.Collections.getByLibrary(USER_LIBRARY_ID, true)` (`planApplier.ts:371-374`). Re-fetching is necessary because the set of collections changed during Phase 1.
2. **Sort deepest-first** by walking `parentID` chains to compute depth (`collectionDepth`, `planApplier.ts:379-390`). Sorting deepest-first ensures a parent collection isn't deleted before its children are checked — though in practice a parent with surviving children will be skipped by the child-collection check anyway, this is belt-and-braces.
3. **Skip just-created collections**: `if (newCollectionIDs.has(col.id)) continue;` (`planApplier.ts:394`) — the new taxonomy's collections must never be deleted even if they happen to be empty (e.g. an item failed to refile into them).
4. **Skip trashed collections**: `if (col.deleted) continue;` (`planApplier.ts:395`).
5. **Check children defensively**: `getChildItems(true)` and `getChildCollections(true)` may throw `UnloadedDataException` if the collection's child data hasn't been loaded from the DB. Each call is wrapped in its own try/catch (`planApplier.ts:402-418`); on either throw the collection is *skipped*, never deleted, with a debug log. This is the conservative choice: if we can't prove a collection is empty, leave it.
6. **Delete only if both empty**: no child items *and* no child collections. Deletion is `await col.eraseTx()` (`planApplier.ts:421`) — again `*Tx`, never a non-transactional erase. `collectionsDeleted++`.

The final `ApplyResult` is assembled and logged at `planApplier.ts:437-449`.

### Caller responsibility: snapshot first

The docstring at `planApplier.ts:102-103` warns: the caller **MUST** capture a `RevertSnapshot` *before* calling `applyPlan`. `applyPlan` performs writes and is not reversible on its own. (The revert path itself is documented in `08-revert-snapshot.md`.)

---

## `planCollectionCreation`

A **pure** helper (`planApplier.ts:463-487`): no Zotero globals, no I/O. Given a taxonomy tree and the set of existing collection paths, returns which paths need to be created vs reused.

```ts
export function planCollectionCreation(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { toCreate: string[]; toReuse: string[] }
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The proposed taxonomy tree (root nodes; each node carries a precomputed slash-delimited `path`). |
| `existingPaths` | `string[]` | Yes | Slash-delimited, root-to-leaf paths of collections already in the library (matching `TaxonomyNode.path` format). |

**Returns:** `{ toCreate: string[]; toReuse: string[] }` — `toReuse` lists taxonomy paths already present in `existingPaths`; `toCreate` lists the rest, in **dependency order** (parents before children).

**Throws:** None. The function is pure and side-effect-free.

- The taxonomy is flattened depth-first (parents before children) via `flattenPaths`.
- A path is `toReuse` if it appears in `existingPaths`, else `toCreate`.
- The returned `toCreate` is in **dependency order** (parents before children), so a caller creating them in list order will always know the parent ID before encountering any child — the same invariant `applyPlan`'s create loop relies on.

The debug calls are guarded with `(globalThis as any).Zotero?.debug?.(...)` (`planApplier.ts:469`, `483`) so they are no-ops outside the plugin sandbox. This is what makes the function unit-testable under plain Node where `Zotero` is undefined. It is also the reason this module deliberately *duplicates* `flattenTaxonomyPaths` and `leafNameOf` from `planValidator` rather than importing them — see `planApplier.ts:492-496`.

---

## Private helpers

### `flattenPaths`

Iterative depth-first flatten of every `path` in the taxonomy (root and leaf, all depths), parent before child. Mirrors `planValidator.flattenTaxonomyPaths` but inlined here to keep the module free of relative runtime imports.

```ts
function flattenPaths(roots: TaxonomyNode[]): string[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `roots` | `TaxonomyNode[]` | Yes | Root taxonomy nodes to flatten. |

**Returns:** `string[]` — every `TaxonomyNode.path` in the tree, depth-first, parent before child. Uses an explicit stack initialized in reverse so nodes pop in document order.

**Throws:** None.

`planApplier.ts:497-508`.

---

### `leafNameOf`

Returns the leaf-name component of a slash-delimited collection path (the substring after the last `/`), or the whole string if there is no `/`. Mirrors the private `leafNameOf` in `planValidator.ts`, kept local for the same import-isolation reason.

```ts
function leafNameOf(path: string): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | Yes | Slash-delimited collection path. |

**Returns:** `string` — the substring after the last `/`, or the whole `path` if no `/` is present.

**Throws:** None.

`planApplier.ts:516-519`.

---

### `findLocalNameCollisions`

Detects leaf-name collisions between a proposed taxonomy and the existing library's collection paths (the `pathToID` map built in Phase 1). **Pure** (no Zotero globals, no I/O).

```ts
function findLocalNameCollisions(
  taxonomy: TaxonomyNode[],
  pathToID: Map<string, number>,
): { taxPath: string; taxLeafName: string; existingPath: string }[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The proposed taxonomy tree to check. |
| `pathToID` | `Map<string, number>` | Yes | Map of existing collection paths to numeric IDs (built in Phase 1). |

**Returns:** `{ taxPath: string; taxLeafName: string; existingPath: string }[]` — one entry per (taxonomy path, conflicting existing path) pair. A taxonomy node whose full path exactly matches an existing path is a reuse and is never reported.

**Throws:** None.

Algorithm:

1. Build `existingByLeaf: Map<string, string[]>` — for every path in `pathToID`, group by leaf name.
2. For every taxonomy path (via `flattenPaths`):
   - If `pathToID.has(taxPath)`, **skip** — this is an exact-path *reuse*; the applier will reuse the existing collection and no new same-named collection would be created (`planApplier.ts:558-562`).
   - Otherwise, look up the taxonomy node's leaf name in `existingByLeaf`. Because `taxPath` is *not* in `pathToID`, every candidate path necessarily differs from it (`planApplier.ts:568`), so each candidate is a genuine collision. Emit `{ taxPath, taxLeafName: leaf, existingPath }` for every candidate (one taxonomy node can collide with multiple existing paths; all are reported so the UI can show the full picture).

This is a private local mirror of `planValidator.findExistingNameCollisions` (`planApplier.ts:536-540`), kept local to preserve `planCollectionCreation`'s plain-Node unit-testability.

The comment at `planApplier.ts:523-535` spells out the bug this guard exists to prevent: in the create loop, a colliding taxonomy node would silently create a brand-new same-named collection under a different parent, leaving the library with two distinct collections that share a name but hold different papers. The guard turns a silent data-corruption hazard into an explicit, surfacable skip.

`planApplier.ts:541-574`.

---

### `buildExistingPath`

Builds the slash-delimited path of an *existing* `Zotero.Collection` by walking `parentID` up to the root through the `existingByID` map. Mirrors `collectionTree.ts`'s `buildCollectionPath` but operates directly on `Zotero.Collection` objects already in hand during apply (no separate lookup closure needed).

```ts
function buildExistingPath(
  col: Zotero.Collection,
  existingByID: Map<number, Zotero.Collection>,
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `col` | `Zotero.Collection` | Yes | The existing collection whose path is being reconstructed. |
| `existingByID` | `Map<number, Zotero.Collection>` | Yes | Map of collection IDs to collection objects, used to walk `parentID` chains upward. |

**Returns:** `string` — the slash-delimited root-to-leaf path. Returns `""` only if a parent is missing; in practice a missing parent just truncates the climb via `current = existingByID.get(pid)` becoming `undefined`, which exits the `while` loop and joins whatever names were collected.

**Throws:** None.

Defensive measures:
- A `visited: Set<number>` guards against cycles in the parent chain (`planApplier.ts:592-595`) — break on revisit.
- If a parent ID is missing from `existingByID` (stale membership), the walk stops and the partial path is returned; the comment at `planApplier.ts:583` says returns `""` only if a parent is missing — in practice a missing parent just truncates the climb via `current = existingByID.get(pid)` becoming `undefined`, which exits the `while` loop and joins whatever names were collected.

`planApplier.ts:584-604`.

---

### `dedupeSorted`

Returns a sorted, de-duplicated copy of `ids`. Numeric IDs only. Used to normalize collection ID lists before `setCollections`, in both the additive (`[...current, ...newIDs]`) and replace (`newIDs` only) branches.

```ts
function dedupeSorted(ids: number[]): number[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | `number[]` | Yes | Collection IDs to normalize. |

**Returns:** `number[]` — a new array with duplicates removed, sorted ascending numerically.

**Throws:** None.

`planApplier.ts:610-621`.

---

### `delay`

Trivial `setTimeout`-based promise. Used to insert the `ITEM_DELAY_MS` gap between item saves.

```ts
function delay(ms: number): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ms` | `number` | Yes | Milliseconds to wait. |

**Returns:** `Promise<void>` — resolves after `ms` milliseconds.

**Throws:** None.

`planApplier.ts:623-625`.

---

## Constants

### `ITEM_DELAY_MS`

```ts
export const ITEM_DELAY_MS = 10;
```

Per-item save gap in milliseconds. The manual `#Organization` session learned that saving many items in a tight loop can overwhelm Zotero's transaction queue; a 10ms gap avoids that. Work-order requirement (`planApplier.ts:77-80`, `81`).

### `USER_LIBRARY_ID`

```ts
const USER_LIBRARY_ID = 1;
```

The user library ID. Matches `libraryReader.ts:56` (`planApplier.ts:72-74`). Not exported.

---

## Work-order safety rules

The module header (`planApplier.ts:1-18`) and inline comments codify four rules learned from prior manual sessions. They are not stylistic preferences — each was motivated by a concrete failure:

| # | Rule | Where enforced | Why |
|---|---|---|---|
| 1 | **`saveTx` only, never raw SQL, never `save()` without a transaction.** | Phase 1 `collection.saveTx()` (`planApplier.ts:238`), Phase 2 `item.saveTx()` (`planApplier.ts:337`), Phase 3 `col.eraseTx()` (`planApplier.ts:421`). | Stated at `planApplier.ts:7-8`. Bypassing the transactional API corrupts Zotero's sync state. |
| 2 | **Address newly-created collections by numeric `id`, never by `key`.** | `id = typeof saved === "number" ? saved : collection.id` (`planApplier.ts:242`); `pathToID: Map<string, number>` throughout. | Stated at `planApplier.ts:8-9` and `239`. "Learned the hard way in the manual session" — string keys were unreliable for the applier's bookkeeping. |
| 3 | **Additive by default.** Existing memberships are preserved unless the caller explicitly opts into `replaceExisting: true`. | Phase 2 merge branch (`planApplier.ts:331-335`). | Stated at `planApplier.ts:15-17` and `26-29`. Per the ask, replace is now **mandatory** in the UI flow, but the type-level default and the additive branch are retained for safety. |
| 4 | **`ITEM_DELAY_MS = 10ms` gap between per-item saves.** | `await delay(ITEM_DELAY_MS)` after each successful refile (`planApplier.ts:342`). | Stated at `planApplier.ts:77-80`. The manual `#Organization` session overwhelmed Zotero's transaction queue by saving items in a tight loop. |

A fifth, implicit rule: **errors are recorded, never aborting the apply** (`planApplier.ts:99-100`). Every per-item operation is wrapped in try/catch, and synthetic errors (`itemId: -1`) record collection-level failures that transitively doom items.

---

## Interactions with other modules

- **`categorizationTypes`** — provides `CategorizationPlan`, `ItemAssignment`, `TaxonomyNode` (type-only import, `planApplier.ts:20-24`). `ItemAssignment` is re-exported (`planApplier.ts:631`) so UI callers can import it from this module.
- **`planValidator`** — `findLocalNameCollisions` and `leafNameOf` are deliberate local mirrors of `planValidator.findExistingNameCollisions` / `planValidator.leafNameOf`. The duplication is the price of keeping `planCollectionCreation` pure and unit-testable under plain Node with no relative runtime imports (`planApplier.ts:492-496`, `513-515`, `536-540`).
- **`collectionTree`** — `buildExistingPath` mirrors `collectionTree.ts`'s `buildCollectionPath`, inlined for the same import-isolation reason and because the applier already has the `Zotero.Collection` objects in hand (`planApplier.ts:577-582`).
- **`libraryReader.ts`** — `USER_LIBRARY_ID = 1` is cross-referenced to `libraryReader.ts:56` (`planApplier.ts:72-74`).
- **Revert snapshot module** — `applyPlan`'s docstring requires the caller to capture a `RevertSnapshot` first (`planApplier.ts:102-103`). `applyPlan` itself performs no snapshotting and is not reversible.

---

## How to extend

- **Add a new phase.** Add it after Phase 3, before assembling `result`. If it has its own progress semantics, extend the `phase` union in `ApplyOptions.onProgress` (currently `"collections" | "refiling" | "cleanup"`). Keep the "errors recorded, never abort" rule: wrap per-item work in try/catch and push to `errors`.
- **Change the throttle.** `ITEM_DELAY_MS` is exported (`planApplier.ts:81`) but applied via a local `delay()` call (`planApplier.ts:342`); there is no per-call override. To make it tunable, add a field to `ApplyOptions`. Do not remove the gap entirely — see work-order rule #4.
- **Different merge strategy.** The merge/replace decision is localized to `planApplier.ts:327-335`. Add a third branch (e.g. "subtractive" — remove only the assigned paths) by extending `ApplyOptions` and branching there. `dedupeSorted` handles normalization.
- **Reuse `planCollectionCreation` outside the plugin.** It is pure and safe under plain Node. The only gotcha is that it depends on `TaxonomyNode.path` being precomputed and slash-delimited; the taxonomy builder must populate `path` before calling it.
- **New collision semantics.** `findLocalNameCollisions` currently reports *all* existing paths sharing a leaf name with a to-be-created taxonomy node. To narrow it (e.g. only flag collisions within the same parent), filter `existingByLeaf` candidates by parent path before emitting.

---

## Summary of design decisions

1. **Pure/write split.** The only Zotero-touching code is `applyPlan` and its Phase 1–3 helpers. Everything the planner needs (`planCollectionCreation`, `findLocalNameCollisions`, `flattenPaths`, `leafNameOf`) is pure and free of relative runtime imports, so it unit-tests under plain Node with `--experimental-strip-types`. The price is intentional code duplication of `planValidator` helpers.
2. **Twin collections: keep lowest ID, log, do not delete.** A pre-existing data-integrity issue treated as user-resolvable corruption; the applier refuses to silently depend on iteration order (`planApplier.ts:138-161`).
3. **Collision guard: fail loud, fail contained.** A taxonomy node whose leaf collides with an existing collection at a different path is *not* created, and its absence from `pathToID` cascades to all children and assignments under it — they fail to resolve with explicit errors rather than silently producing same-named siblings (`planApplier.ts:163-191`, `218-229`).
4. **`saveTx` / `eraseTx` everywhere; numeric IDs only; additive by default; 10ms throttle.** The four work-order safety rules.
5. **Errors recorded, never aborting.** Every per-item operation is try/caught; synthetic `itemId: -1` errors record collection-level failures. Partial success is always returned (`planApplier.ts:99-100`).
6. **Phase 3 only in replace mode.** Additive mode leaves existing collections populated, so cleanup would be wrong; it is skipped entirely (`planApplier.ts:431-435`).
