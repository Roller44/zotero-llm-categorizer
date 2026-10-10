# Revert Snapshot System

This module (`src/modules/revertSnapshot.ts`) implements the pre-state snapshot and revert logic for the Gate 4 write path of the Smart Organizer plugin. It is the safety net that makes the plugin's destructive `applyPlan()` operation reversible: before any collection-membership write is applied, the organizer records what the library looked like, and if the user clicks "Revert", this module restores that state.

## Purpose and Position in the Pipeline

The Smart Organizer's categorizer produces a `CategorizationPlan` that, when applied by `planApplier.applyPlan()`, mutates two things in the user's Zotero library:

1. Each regular item's collection memberships (items get added to / removed from collections).
2. The set of collections itself (apply may create new collections to hold categorized items).

Both of these are destructive. A user who runs a categorization and dislikes the result needs a way to put the library back exactly as it was. The revert snapshot system provides that.

The contract is two-phase:

- **Capture phase** — `captureSnapshot()` is called *before* `applyPlan()`. It performs read-only enumeration of every regular item's collection IDs plus the set of all collection IDs that currently exist. The result is a `RevertSnapshot`.
- **Revert phase** — `revertFromSnapshot(snapshot)` is called only if the user explicitly requests it. It restores each item's memberships to the recorded IDs (a full replace) and deletes any collection that was created by the apply and is now empty.

The ordering — capture before apply — is non-negotiable and is enforced by the UI layer that orchestrates the write path. The module header comment states this explicitly:

> Snapshot is captured BEFORE any write, so revert can fully revert. (`revertSnapshot.ts:17`)

If a snapshot were taken after apply, it would record the post-apply state and revert would be a no-op. The UI therefore holds a single `RevertSnapshot` instance, captured at the moment the user confirms the plan, and passes it to `revertFromSnapshot()` only on the "Revert" action.

## Types

### `ItemMembershipSnapshot`

One row of the per-item state: the Zotero item ID plus the collection IDs the item was a member of at capture time.

```ts
export interface ItemMembershipSnapshot {
  /** The Zotero itemID. */
  itemId: number;
  /** The item's collection IDs at snapshot time (numeric). */
  collectionIDs: number[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | The Zotero numeric item ID (`item.id`). |
| `collectionIDs` | `number[]` | Snapshot of `item.getCollections()` at capture time. Numeric collection IDs — never the string `collection.key` (see *Design decisions* below). |

Defined at `revertSnapshot.ts:27-32`.

### `RevertSnapshot`

The full revert state.

```ts
export interface RevertSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: Set<number>;
  timestamp: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `items` | `ItemMembershipSnapshot[]` | Per-item memberships, one entry per regular, non-trashed item in the user library at capture time. |
| `existingCollectionIDs` | `Set<number>` | The set of collection IDs that existed *before* apply. Revert uses this to decide which collections were created by the apply and are therefore candidates for deletion. |
| `timestamp` | `string` | ISO timestamp of when the snapshot was captured, for diagnostics and persistence. |

Defined at `revertSnapshot.ts:43-47`.

The on-the-wire form (used by `serializeSnapshot` / `deserializeSnapshot`) represents `existingCollectionIDs` as a sorted `number[]` rather than a `Set`, because JSON has no Set type. `deserializeSnapshot` rebuilds the Set on load.

### `SerializedSnapshot`

Internal wire shape used by serialize/deserialize. `existingCollectionIDs` is serialized as a sorted array; everything else mirrors `RevertSnapshot`. Not exported — it is an implementation detail of the (de)serialization helpers.

```ts
interface SerializedSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: number[];
  timestamp: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `items` | `ItemMembershipSnapshot[]` | Per-item memberships (same shape as `RevertSnapshot.items`). |
| `existingCollectionIDs` | `number[]` | The pre-apply collection IDs as a sorted array (JSON has no Set type). |
| `timestamp` | `string` | ISO timestamp, mirroring `RevertSnapshot.timestamp`. |

Defined at `revertSnapshot.ts:53-57`.

### `USER_LIBRARY_ID` (internal constant)

```ts
const USER_LIBRARY_ID = 1;
```

The user library ID. The rest of the plugin uses libraryID `1` (the personal library); see `libraryReader.ts:56` (`Zotero.Items.getAll(1)`). Defined at `revertSnapshot.ts:63`.

### Return type of `revertFromSnapshot`

A summary of what was restored.

```ts
{
  itemsRestored: number;
  collectionsDeleted: number;
  errors: { itemId?: number; error: string }[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `itemsRestored` | `number` | Count of items whose memberships were successfully reset. Items skipped because they no longer exist are not counted; items that threw are counted in `errors` instead. |
| `collectionsDeleted` | `number` | Count of collections created by the apply that were empty after restore and were successfully erased. |
| `errors` | `{ itemId?: number; error: string }[]` | Per-item and per-collection failure messages. An entry with `itemId` set is an item-restore failure; an entry without it is a collection-delete failure. |

## Public API

### captureSnapshot

Capture the current membership state of every regular, non-trashed item in the user library, plus the set of collection IDs that currently exist.

```ts
export async function captureSnapshot(): Promise<RevertSnapshot>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | Takes no arguments. |

**Returns:** `Promise<RevertSnapshot>` — the captured snapshot (`items`, `existingCollectionIDs`, `timestamp`).

**Throws:** None. Read-only — no `saveTx`, no writes.

**MUST be called before any apply write.** Reads only.

#### Internal logic

1. Enumerate all items via `Zotero.Items.getAll(USER_LIBRARY_ID)`, where `USER_LIBRARY_ID = 1` is the personal library (the same read surface used by `libraryReader.ts:56`). See `revertSnapshot.ts:79`.
2. For each item, skip it unless `item.isRegularItem() && !item.deleted` — this matches the filter in `libraryReader.ts:62`. See `revertSnapshot.ts:84`.
3. For each surviving item, read `item.getCollections()` (typed `number[]` in `zotero-types` `item.d.ts:987`) and defensive-copy with `.slice()`. Push `{ itemId: item.id, collectionIDs }` onto the items array. See `revertSnapshot.ts:87-88`.
4. Enumerate existing collections via `Zotero.Collections.getByLibrary(USER_LIBRARY_ID, true)` (`collections.d.ts:40`), which returns all collections in the personal library, recursively. Build a `Set<number>` of their `.id` values. See `revertSnapshot.ts:91-97`.
5. Construct and return the `RevertSnapshot` with an ISO timestamp. Emit `Zotero.debug` lines on entry and exit recording the item count and existing-collection count for diagnostics. See `revertSnapshot.ts:99-108`.

#### Why `USER_LIBRARY_ID = 1`

The rest of the plugin operates on the personal library, which Zotero addresses as library ID `1` — `libraryReader.ts:56` calls `Zotero.Items.getAll(1)`. Revert must read the same library the apply wrote to, so it hard-codes the same constant. If the plugin is ever extended to group libraries, this constant is the place to parameterize. See `revertSnapshot.ts:60-63`.

### revertFromSnapshot

Restore the library to the state recorded in `snapshot`.

```ts
export async function revertFromSnapshot(
  snapshot: RevertSnapshot,
): Promise<{
  itemsRestored: number;
  collectionsDeleted: number;
  errors: { itemId?: number; error: string }[];
}>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `snapshot` | `RevertSnapshot` | Yes | The pre-apply snapshot to restore from. |

**Returns:** `Promise<{ itemsRestored: number; collectionsDeleted: number; errors: { itemId?: number; error: string }[] }>` — summary of what was restored (see the return-type table above).

**Throws:** None. Per-item and per-collection failures are caught and reported in the returned `errors` array rather than thrown; the function always resolves.

#### Internal logic — item restoration

1. Iterate `snapshot.items` in order. For each entry, look up the item via `Zotero.Items.get(snap.itemId)`. See `revertSnapshot.ts:139-141`.
2. If the item is gone or has been trashed since the snapshot, skip it (with a debug log). This is the graceful path for "user deleted an item between apply and revert" — revert cannot and should not resurrect it. See `revertSnapshot.ts:142-148`.
3. Otherwise call `item.setCollections(snap.collectionIDs)` (typed at `item.d.ts:996`; accepts IDs or keys, but only numeric IDs are passed). This is a *full replace*: the item's memberships become exactly the recorded set, not a union. See `revertSnapshot.ts:149-151`.
4. `await item.saveTx()` to commit. See `revertSnapshot.ts:152`.
5. Increment `itemsRestored` and `await delay(REVERT_DELAY_MS)` (10 ms) before the next item. See `revertSnapshot.ts:153-154`.
6. On any thrown error, log it and push `{ itemId, error }` onto `errors`; do not abort the loop. See `revertSnapshot.ts:155-163`.

#### Internal logic — collection deletion

After all items are restored, the function cleans up collections that the apply created and that are now empty:

1. Re-enumerate the library's collections via `Zotero.Collections.getByLibrary(USER_LIBRARY_ID, true)`. This is a fresh read, not the snapshot's set, because apply may have created collections whose IDs were never in the snapshot. See `revertSnapshot.ts:167-171`.
2. For each current collection, skip it if its `id` is in `snapshot.existingCollectionIDs` — it existed before apply, so revert must not touch it. See `revertSnapshot.ts:175-179`.
3. Skip it if `col.hasChildItems() || col.hasChildCollections()` — revert only deletes collections that are empty *after* the restore. A non-empty created-by-apply collection means the user (or some other process) put something in it that the snapshot did not record; deleting it would lose data. See `revertSnapshot.ts:180-183`.
4. Otherwise `await col.eraseTx()` to delete it. On success, increment `collectionsDeleted`. On a thrown error, log it and push a collection-error entry (no `itemId`). See `revertSnapshot.ts:184-202`.
5. Return the summary object. See `revertSnapshot.ts:204-208`.

#### The `eraseTx()` return-value bug

There is a subtlety in the success path at `revertSnapshot.ts:189`:

```ts
await col.eraseTx();
collectionsDeleted++;
```

The naive expectation is that `eraseTx()` resolves to `true` on success and the code should check that. It does not. `eraseTx()` calls `erase()`, which returns `Zotero.DB.executeTransaction(async fn)` where the async callback has no explicit return — so `eraseTx()` resolves to `undefined` on success, not `true`. The code is correct as written: it relies on `await` throwing on failure (the promise rejects) and falling into the `catch` block, and on a successful await unconditionally incrementing the counter. The comment at `revertSnapshot.ts:185-188` documents this so a future maintainer does not "fix" the missing `if (await col.eraseTx())` check and break the success path.

### REVERT_DELAY_MS

Delay between item saves, in milliseconds.

```ts
export const REVERT_DELAY_MS = 10;
```

Value: `10` (ms). Mirrors the apply path's `ITEM_DELAY_MS` to avoid overwhelming Zotero's transaction queue. The module comment at `revertSnapshot.ts:122` notes this is "lesson from the manual session" — i.e. a prior manual testing session discovered that firing many `saveTx()` calls back-to-back starves Zotero's transaction queue, so a small inter-call yield is required on both the apply and revert paths. Defined at `revertSnapshot.ts:215`.

### serializeSnapshot

Serialize a `RevertSnapshot` to a stable JSON string.

```ts
export function serializeSnapshot(snapshot: RevertSnapshot): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `snapshot` | `RevertSnapshot` | Yes | The snapshot to serialize. |

**Returns:** `string` — a pretty-printed JSON string (`JSON.stringify(wire, null, 2)`) representing the snapshot.

**Throws:** None. **Pure: no Zotero globals, no I/O** — this is deliberate so the helper can be unit-tested under plain Node and so the snapshot can be persisted to a Zotero pref across restarts.

The `existingCollectionIDs` Set is emitted as a sorted array (`[...set].sort((a, b) => a - b)`) so the output is deterministic, which is useful for snapshot equality in tests and for stable pref storage. Each item's `collectionIDs` is defensive-copied via `.slice()` so the serialized form cannot be aliased by a later mutation of the input.

See `revertSnapshot.ts:223-235`.

### deserializeSnapshot

Parse a `serializeSnapshot` string back into a `RevertSnapshot`.

```ts
export function deserializeSnapshot(json: string): RevertSnapshot
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `string` | Yes | The JSON string produced by `serializeSnapshot`. |

**Returns:** `RevertSnapshot` — the parsed snapshot, with `existingCollectionIDs` rebuilt as a `Set<number>` from the serialized array.

**Throws:** `Error` if the input is not valid JSON or does not match the expected shape. **Pure: no Zotero globals, no I/O.**

Callers should treat a throw as "no usable snapshot" (e.g. fall back to disabling the Revert button). The shape check is defensive and structural:

- Root must be an object. See `revertSnapshot.ts:250-252`.
- `items` must be an array; each entry must be an object with a finite-number `itemId` and an array of finite-number `collectionIDs`. See `revertSnapshot.ts:255-281`.
- `existingCollectionIDs` must be an array of finite numbers; it is rebuilt into a `Set<number>`. See `revertSnapshot.ts:283-296`.
- `timestamp` is coerced: a non-string becomes `""` rather than throwing, because a missing timestamp is not structurally fatal. See `revertSnapshot.ts:298-299`.

The elementwise finite-number checks (`Number.isFinite`) reject `NaN`, `Infinity`, and stringified numbers that survived `JSON.parse` as strings — these would silently corrupt the revert if accepted. Each error message names the exact path (e.g. `snapshot.items[3].collectionIDs[2]`) so a corrupt pref can be diagnosed.

See `revertSnapshot.ts:247-302`.

### delay (internal)

A trivial `setTimeout`-based promise used between item saves. Not exported.

```ts
function delay(ms: number): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ms` | `number` | Yes | Milliseconds to wait before resolving. |

**Returns:** `Promise<void>` — resolves after `ms` milliseconds.

**Throws:** None.

See `revertSnapshot.ts:304-306`.

## Design Decisions

### Numeric collection IDs, never keys

The module header states a hard rule:

> Address newly-created collections by `collection.id` (numeric), NEVER by `collection.key`. (`revertSnapshot.ts:13-15`)

`existingCollectionIDs` and `ItemMembershipSnapshot.collectionIDs` both hold numeric IDs. This matters because Zotero collection keys are stable string identifiers but the apply path creates new collections and addresses them by numeric ID throughout; mixing the two would require a translation table and risk subtle bugs. Standardizing on numeric IDs end-to-end keeps the snapshot directly comparable to the live `Zotero.Collections.getByLibrary()` results, which expose `.id`.

### Snapshot ordering is enforced by the UI, not by this module

`captureSnapshot()` does not lock the library or check that no apply is in flight. It is a pure read. The contract that it runs *before* `applyPlan()` is enforced by the UI orchestrator that holds the snapshot reference. This module's responsibility is to provide the read and the restore; the ordering guarantee is a property of the caller. The module documents the requirement in its header (`revertSnapshot.ts:17`) so the contract is explicit, but it does not defend against a misbehaving caller.

### Full replace, not union, on revert

`item.setCollections(snap.collectionIDs)` is a full replacement, not a merge. This is the explicit user-requested revert, so the goal is to make the library identical to the pre-apply state. If a user manually moved an item into a new collection between apply and revert, that manual change is discarded — which is the correct semantics for "undo the categorization", but worth noting: revert is not a selective undo of only the apply's writes; it is a restore to the captured point in time.

### Created-by-apply collections are deleted only if empty

The collection-deletion loop (`revertSnapshot.ts:175-202`) only deletes collections whose `id` is *not* in `snapshot.existingCollectionIDs` (i.e. created during or after apply) *and* that have no child items and no child collections after the restore. This is the conservative choice: a non-empty created-by-apply collection means something is in it that the snapshot did not record (a manual addition, or an item the restore skipped because it had been trashed), and deleting it would lose that data. The snapshot is left with the empty collection rather than silently destroying content.

### Items deleted between snapshot and revert are skipped, not restored

If `Zotero.Items.get(snap.itemId)` returns a falsy value or an item with `deleted === true`, revert logs and continues (`revertSnapshot.ts:142-148`). It cannot resurrect a trashed item, and trying to `setCollections` on a missing item would throw. The item is not counted in `itemsRestored` and is not added to `errors`; it is simply absent from the result.

### Pure (de)serialization for testability and persistence

`serializeSnapshot` and `deserializeSnapshot` are deliberately free of Zotero globals so they can be unit-tested under plain Node and so the snapshot can be persisted to a Zotero preference across restarts. The on-the-wire form is deterministic (sorted `existingCollectionIDs` array) so two snapshots of the same state serialize identically, which makes snapshot equality assertions in tests stable.

### `eraseTx()` resolves to `undefined`

Documented above and in the source at `revertSnapshot.ts:185-188`: `Zotero.Collection.eraseTx()` resolves to `undefined` on success because the underlying `Zotero.DB.executeTransaction(async fn)` callback has no explicit return. The code does not check the resolved value; it relies on the promise rejecting on failure. A maintainer adding `if (await col.eraseTx())` would break the success path because the resolved value is never truthy.

## Interactions with Other Modules

- **`planApplier.applyPlan()`** — the consumer of the snapshot's pre-state. `applyPlan` mutates item memberships and creates collections; `revertFromSnapshot` is its inverse. The two never run concurrently — the UI sequences them.
- **`libraryReader.ts`** — defines the read surface this module mirrors: `USER_LIBRARY_ID = 1`, `Zotero.Items.getAll(1)`, and the `isRegularItem() && !deleted` filter at `libraryReader.ts:62`. `captureSnapshot` reuses the same filter so the snapshot covers exactly the items the categorizer considered.
- **UI orchestrator** — holds the `RevertSnapshot` instance, captures it on plan confirmation, and calls `revertFromSnapshot` on the "Revert" action. May persist the snapshot via `serializeSnapshot` to a Zotero pref to survive restarts.

## Extending and Modifying

- **Group library support.** Parameterize `USER_LIBRARY_ID` (currently `revertSnapshot.ts:63`) — pass it into `captureSnapshot` and `revertFromSnapshot`, or read it from the same place the rest of the plugin resolves the active library. The `Zotero.Items.getAll` and `Zotero.Collections.getByLibrary` calls already accept a library ID argument.
- **Selective revert.** To revert only some items, filter `snapshot.items` before passing it in, or add an `itemFilter` argument to `revertFromSnapshot`. The per-item loop is independent and safe to subset.
- **Not deleting created-by-apply collections.** If you want revert to restore memberships but leave the new (possibly empty) collections in place, drop the collection-deletion loop (`revertSnapshot.ts:166-202`) and return `collectionsDeleted: 0`.
- **Increasing the inter-save delay.** If Zotero's transaction queue is still being overwhelmed on large libraries, raise `REVERT_DELAY_MS` (`revertSnapshot.ts:215`). It mirrors the apply path's `ITEM_DELAY_MS`; keep them in sync.
- **Persisting the snapshot.** Use `serializeSnapshot` to write the snapshot to a Zotero pref and `deserializeSnapshot` to load it. The deserializer's defensive shape checks mean a corrupt or partial pref throws cleanly instead of producing a half-built snapshot that would mis-revert.

## Safety Rules (from the work order)

These are reproduced in the module header (`revertSnapshot.ts:11-17`) and are non-negotiable:

- **No raw SQL writes.** All writes go through the Zotero JS API with `saveTx()` / `eraseTx()`.
- **Address newly-created collections by `collection.id` (numeric), never by `collection.key`.**
- **Snapshot is captured before any write**, so revert can fully restore.

Violating any of these breaks the revert guarantee and is treated as a bug.
