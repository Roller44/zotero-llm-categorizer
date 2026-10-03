/**
 * Pre-state snapshot + revert logic for the Gate 4 write path.
 *
 * Before any apply (`planApplier.applyPlan`), the organizer captures a
 * `RevertSnapshot` recording every regular item's current collection IDs plus
 * the set of collection IDs that already existed. If the user clicks "Revert",
 * `revertFromSnapshot` restores each item's memberships to the recorded IDs and
 * optionally deletes collections that were created by the apply (i.e. IDs not
 * in `existingCollectionIDs`) if they are empty after the restore.
 *
 * Safety rules (NON-NEGOTIABLE, from the work order's "Write-path safety
 * rules"):
 *   - NO raw SQL writes. All writes via the Zotero JS API + `saveTx()`.
 *   - Address newly-created collections by `collection.id` (numeric), NEVER by
 *     `collection.key`. (`existingCollectionIDs` and `ItemMembershipSnapshot`
 *     hold numeric IDs.)
 *   - Snapshot is captured BEFORE any write, so revert can fully restore.
 *
 * The pure serialization helpers (`serializeSnapshot`,
 * `deserializeSnapshot`) live in this module and have no Zotero globals so they
 * can be unit-tested under plain Node.
 */

/**
 * One item's collection memberships at snapshot time.
 */
export interface ItemMembershipSnapshot {
  /** The Zotero itemID. */
  itemId: number;
  /** The item's collection IDs at snapshot time (numeric). */
  collectionIDs: number[];
}

/**
 * Full revert state. `existingCollectionIDs` distinguishes collections that
 * existed before apply from those created by apply (so revert can delete the
 * new empty ones).
 *
 * The on-the-wire form (used by `serializeSnapshot` / `deserializeSnapshot`)
 * represents `existingCollectionIDs` as a sorted `number[]` rather than a
 * `Set`, because JSON has no Set type. `deserializeSnapshot` rebuilds the Set.
 */
export interface RevertSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: Set<number>;
  timestamp: string;
}

/**
 * Internal wire shape used by serialize/deserialize. `existingCollectionIDs`
 * is serialized as a sorted array; everything else mirrors `RevertSnapshot`.
 */
interface SerializedSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: number[];
  timestamp: string;
}

/**
 * The user library ID. The rest of the plugin uses libraryID `1` (the personal
 * library); see `libraryReader.ts:56` (`Zotero.Items.getAll(1)`).
 */
const USER_LIBRARY_ID = 1;

/**
 * Capture the current membership state of every regular, non-trashed item in
 * the user library, plus the set of collection IDs that currently exist.
 *
 * MUST be called BEFORE any apply write. Reads only — no `saveTx`, no writes.
 *
 * Uses `Zotero.Items.getAll(1)` (the same read surface as `libraryReader.ts`)
 * to enumerate items and `item.getCollections()` (typed `number[]` in
 * `zotero-types` item.d.ts:987) for memberships. Existing collection IDs come
 * from `Zotero.Collections.getByLibrary(1, true)` (collections.d.ts:40) — all
 * collections in the personal library, recursively.
 */
export async function captureSnapshot(): Promise<RevertSnapshot> {
  Zotero.debug("[SmartOrganizer] captureSnapshot: entry");
  const all = (await Zotero.Items.getAll(USER_LIBRARY_ID)) as Zotero.Item[];

  const items: ItemMembershipSnapshot[] = [];
  for (const item of all) {
    // Match libraryReader.ts:62 — only regular, non-trashed items.
    if (!item.isRegularItem() || item.deleted) {
      continue;
    }
    const collectionIDs = (item.getCollections() ?? []).slice();
    items.push({ itemId: item.id, collectionIDs });
  }

  const existingCollections = Zotero.Collections.getByLibrary(
    USER_LIBRARY_ID,
    true,
  ) as Zotero.Collection[];
  const existingCollectionIDs = new Set<number>(
    existingCollections.map((c) => c.id),
  );

  const snapshot: RevertSnapshot = {
    items,
    existingCollectionIDs,
    timestamp: new Date().toISOString(),
  };
  Zotero.debug(
    `[SmartOrganizer] captureSnapshot: exit — ${items.length} items, ` +
      `${existingCollectionIDs.size} existing collections`,
  );
  return snapshot;
}

/**
 * Restore the library to the state recorded in `snapshot`.
 *
 * For each item in the snapshot, set its collection memberships back to the
 * recorded IDs (a full replace, since this is the explicit user-requested
 * revert). For collections created by the apply (IDs not in
 * `snapshot.existingCollectionIDs`), if they are empty after the restore,
 * delete them via `eraseTx()` so the library returns to its pre-apply shape.
 *
 * All writes go through `item.saveTx()` and `collection.eraseTx()` — no raw
 * SQL. A small delay (`REVERT_DELAY_MS`) between items avoids overwhelming
 * Zotero's transaction queue (lesson from the manual session).
 *
 * Returns a summary of what was restored.
 */
export async function revertFromSnapshot(
  snapshot: RevertSnapshot,
): Promise<{
  itemsRestored: number;
  collectionsDeleted: number;
  errors: { itemId?: number; error: string }[];
}> {
  Zotero.debug(
    `[SmartOrganizer] revertFromSnapshot: entry — ${snapshot.items.length} items`,
  );
  const errors: { itemId?: number; error: string }[] = [];
  let itemsRestored = 0;

  for (const snap of snapshot.items) {
    try {
      const item = Zotero.Items.get(snap.itemId);
      // Items may have been deleted between snapshot and revert; skip if so.
      if (!item || item.deleted) {
        Zotero.debug(
          `[SmartOrganizer] revertFromSnapshot: skipping item ${snap.itemId} (not found or trashed)`,
        );
        continue;
      }
      // Full replace: set to the recorded IDs. setCollections takes IDs or
      // keys (item.d.ts:996); we pass numeric IDs only.
      item.setCollections(snap.collectionIDs);
      await item.saveTx();
      itemsRestored++;
      await delay(REVERT_DELAY_MS);
    } catch (e) {
      Zotero.debug(
        `[SmartOrganizer] revertFromSnapshot: error restoring item ${snap.itemId}: ${e}`,
      );
      errors.push({
        itemId: snap.itemId,
        error: (e as Error).message ?? String(e),
      });
    }
  }

  // Delete newly-created (by apply) collections that are now empty.
  let collectionsDeleted = 0;
  const currentCollections = Zotero.Collections.getByLibrary(
    USER_LIBRARY_ID,
    true,
  ) as Zotero.Collection[];
  Zotero.debug(
    `[SmartOrganizer] revertFromSnapshot: ${currentCollections.length} collections now in library; checking for empty created-by-apply collections to delete`,
  );
  for (const col of currentCollections) {
    // Only delete collections that did NOT exist before apply.
    if (snapshot.existingCollectionIDs.has(col.id)) {
      continue;
    }
    // Only delete if empty (no child items and no child collections).
    if (col.hasChildItems() || col.hasChildCollections()) {
      continue;
    }
    try {
      // eraseTx() resolves to `undefined` on success (it calls erase(), which
      // returns `Zotero.DB.executeTransaction(async fn)` where the async
      // callback has no explicit return). The catch block handles actual
      // failures, so on a successful await we always increment.
      await col.eraseTx();
      collectionsDeleted++;
      Zotero.debug(
        `[SmartOrganizer] revertFromSnapshot: deleted collection ${col.id} (${col.name})`,
      );
    } catch (e) {
      Zotero.debug(
        `[SmartOrganizer] revertFromSnapshot: failed to delete collection ${col.id}: ${e}`,
      );
      errors.push({
        error: `Failed to delete collection ${col.id}: ${(e as Error).message ?? String(e)}`,
      });
    }
  }

  Zotero.debug(
    `[SmartOrganizer] revertFromSnapshot: exit — ${itemsRestored} items restored, ` +
      `${collectionsDeleted} collections deleted, ${errors.length} errors`,
  );
  return { itemsRestored, collectionsDeleted, errors };
}

/**
 * Delay between item saves, in milliseconds. Mirrors the apply path's
 * `ITEM_DELAY_MS` to avoid overwhelming Zotero's transaction queue.
 */
export const REVERT_DELAY_MS = 10;

/**
 * Serialize a `RevertSnapshot` to a stable JSON string. Pure: no Zotero
 * globals, no I/O. The `existingCollectionIDs` Set is emitted as a sorted
 * array so the output is deterministic (useful for tests and for persisting
 * the snapshot to a pref across Zotero restarts).
 */
export function serializeSnapshot(snapshot: RevertSnapshot): string {
  const wire: SerializedSnapshot = {
    items: snapshot.items.map((it) => ({
      itemId: it.itemId,
      collectionIDs: it.collectionIDs.slice(),
    })),
    existingCollectionIDs: [...snapshot.existingCollectionIDs].sort(
      (a, b) => a - b,
    ),
    timestamp: snapshot.timestamp,
  };
  return JSON.stringify(wire, null, 2);
}

/**
 * Parse a `serializeSnapshot` string back into a `RevertSnapshot`. Pure: no
 * Zotero globals, no I/O. Rebuilds the `existingCollectionIDs` Set from the
 * serialized array.
 *
 * Throws if the input is not valid JSON or does not match the expected shape
 * (callers should treat a throw as "no usable snapshot"). The shape check is
 * defensive: missing/extra fields are tolerated only when they have a safe
 * default; structural mismatches (non-array `items`, non-number IDs) throw.
 */
export function deserializeSnapshot(json: string): RevertSnapshot {
  const parsed = JSON.parse(json) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("snapshot root is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  const rawItems = obj.items;
  if (!Array.isArray(rawItems)) {
    throw new Error("snapshot.items is not an array");
  }
  const items: ItemMembershipSnapshot[] = rawItems.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`snapshot.items[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    const itemId = r.itemId;
    if (typeof itemId !== "number" || !Number.isFinite(itemId)) {
      throw new Error(`snapshot.items[${i}].itemId is not a finite number`);
    }
    const rawIds = r.collectionIDs;
    if (!Array.isArray(rawIds)) {
      throw new Error(`snapshot.items[${i}].collectionIDs is not an array`);
    }
    const collectionIDs = rawIds.map((id, j) => {
      if (typeof id !== "number" || !Number.isFinite(id)) {
        throw new Error(
          `snapshot.items[${i}].collectionIDs[${j}] is not a finite number`,
        );
      }
      return id;
    });
    return { itemId, collectionIDs };
  });

  const rawExisting = obj.existingCollectionIDs;
  if (!Array.isArray(rawExisting)) {
    throw new Error("snapshot.existingCollectionIDs is not an array");
  }
  const existingCollectionIDs = new Set<number>(
    rawExisting.map((id, j) => {
      if (typeof id !== "number" || !Number.isFinite(id)) {
        throw new Error(
          `snapshot.existingCollectionIDs[${j}] is not a finite number`,
        );
      }
      return id;
    }),
  );

  const timestamp =
    typeof obj.timestamp === "string" ? obj.timestamp : "";

  return { items, existingCollectionIDs, timestamp };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
