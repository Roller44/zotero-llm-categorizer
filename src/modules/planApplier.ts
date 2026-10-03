/**
 * The Gate 4 write path: create proposed collections and refile items.
 *
 * `applyPlan()` walks a `CategorizationPlan`'s taxonomy, creates any
 * collections that don't already exist (matching by name + parent path), then
 * refiles each item into its assigned collection IDs. All writes go through
 * the Zotero JS API with `saveTx()` — NO raw SQL. Newly-created collections
 * are addressed by `collection.id` (numeric), NEVER by `collection.key`
 * (work-order safety rule, learned the hard way in the manual session).
 *
 * `planCollectionCreation()` is a PURE helper that, given a taxonomy and the
 * set of existing collection paths, returns which paths need to be created vs
 * reused. It has no Zotero globals and is unit-tested under plain Node.
 *
 * Additive by default: existing item memberships are preserved unless the
 * caller passes `replaceExisting: true` (the UI's "Replace existing
 * collection memberships" checkbox).
 */

import type {
  CategorizationPlan,
  ItemAssignment,
  TaxonomyNode,
} from "./categorizationTypes";

/**
 * Options for `applyPlan`. `replaceExisting` defaults to `false` so apply is
 * additive by default (work-order safety rule #3).
 */
export interface ApplyOptions {
  /** If true, remove existing collection memberships before adding new ones. */
  replaceExisting: boolean;
  /**
   * Optional progress callback. Called with a human-readable message, the
   * current item/index, and the total, so the UI can update a progress bar.
   * The callback is invoked synchronously and should be cheap (e.g. set a
   * variable that a timer flushes to the DOM — do NOT touch the DOM directly
   * from here, as apply runs in a tight async loop).
   */
  onProgress?: (update: {
    phase: "collections" | "refiling" | "cleanup";
    message: string;
    current: number;
    total: number;
  }) => void;
}

/**
 * Result of an apply. Counts plus a per-item error list so the UI can show
 * partial-failure details without losing the successes.
 *
 * `nameCollisions` records taxonomy nodes that were SKIPPED because their leaf
 * name collides with an existing collection at a different path — the root
 * cause of the duplicate-collection-name bug. Surfaced to the review UI so the
 * user can edit the taxonomy before re-applying. Each entry names the taxonomy
 * path that would have been created, the conflicting existing collection's
 * path, and the shared leaf name.
 */
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

/**
 * The user library ID. Matches `libraryReader.ts:56`.
 */
const USER_LIBRARY_ID = 1;

/**
 * Delay between per-item saves, in milliseconds. The manual `#Organization`
 * session learned that saving many items in a tight loop can overwhelm
 * Zotero's transaction queue; a 10ms gap avoids that. Work-order requirement.
 */
export const ITEM_DELAY_MS = 10;

/**
 * Apply a `CategorizationPlan` to the live library.
 *
 * Two phases:
 *   1. **Create collections.** Walk the taxonomy depth-first (parents before
 *      children). For each `TaxonomyNode`, check whether a collection with the
 *      same name already exists under the resolved parent (path-match). If
 *      not, create it via `new Zotero.Collection()` + `saveTx()` and record
 *      its numeric `id`. Build a `path -> collectionID` map.
 *   2. **Refile items.** For each `ItemAssignment`, resolve its
 *      `collectionPaths` to IDs via the map. If `replaceExisting`, first call
 *      `item.setCollections([])` (clear), then `item.setCollections(newIDs)`.
 *      Otherwise, merge the new IDs with the item's current IDs and call
 *      `setCollections(merged)` (additive). `await item.saveTx()` per item
 *      with a `ITEM_DELAY_MS` gap.
 *
 * Errors are recorded per-item and do not abort the apply (work-order
 * requirement: "Handle errors gracefully — record and continue").
 *
 * The caller MUST capture a `RevertSnapshot` BEFORE calling this function;
 * this function performs writes and is not reversible on its own.
 */
export async function applyPlan(
  plan: CategorizationPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  Zotero.debug(
    `[SmartOrganizer] applyPlan: entry — ${plan.assignments.length} assignments, ` +
      `${plan.stats.totalCollections} collections, replaceExisting=${options.replaceExisting}`,
  );
  const errors: { itemId: number; error: string }[] = [];
  const nameCollisions: {
    taxPath: string;
    taxLeafName: string;
    existingPath: string;
  }[] = [];
  let collectionsCreated = 0;
  let itemsRefiled = 0;

  Zotero.debug("[SmartOrganizer] applyPlan: Phase 1 — create collections");
  // Phase 1: resolve / create collections. path -> numeric collectionID.
  const pathToID = new Map<string, number>();
  const totalPaths = flattenPaths(plan.taxonomy).length;

  // Seed the map with existing collections (so we reuse rather than duplicate).
  // Build existing path -> id by walking parentID chains.
  const existingCols = Zotero.Collections.getByLibrary(
    USER_LIBRARY_ID,
    true,
  ) as Zotero.Collection[];
  const existingByID = new Map<number, Zotero.Collection>();
  for (const c of existingCols) {
    existingByID.set(c.id, c);
  }
  // Existing full path -> id. If two existing collections produce the same
  // path (twin collections: same name AND same parent — Zotero permits this),
  // pick the one with the LOWEST id deterministically and log a warning, so we
  // don't silently depend on iteration order. (Defensive secondary measure for
  // the duplicate-name bug; twins are pre-existing library corruption the user
  // should resolve manually.)
  for (const c of existingCols) {
    const path = buildExistingPath(c, existingByID);
    if (!path) continue;
    const prior = pathToID.get(path);
    if (prior === undefined) {
      pathToID.set(path, c.id);
    } else {
      const keepId = Math.min(prior, c.id);
      const dropId = Math.max(prior, c.id);
      if (prior !== keepId) {
        pathToID.set(path, keepId);
      }
      Zotero.debug(
        `[SmartOrganizer] Twin collections share path "${path}" ` +
          `(ids ${prior} and ${c.id}); keeping id ${keepId}, ` +
          `ignoring id ${dropId}. Resolve the duplicate manually.`,
      );
    }
  }

  // Pre-apply guard: detect taxonomy nodes that the create loop would have to
  // CREATE (their full path is not yet known) whose LEAF name matches an
  // existing collection at a DIFFERENT path. Creating such a node would
  // silently produce a second collection with the same name but a different
  // parent and different papers — exactly the duplicate-name bug. We collect
  // the full collision list up front (so the review UI can surface all of them
  // at once) and also use it per-node in the create loop to skip the offending
  // subtree rather than silently create a same-named sibling.
  const collisions = findLocalNameCollisions(plan.taxonomy, pathToID);
  // Index by taxPath for O(1) lookup in the create loop. Multiple existing
  // paths can share a leaf name; we keep all of them for the UI report but the
  // skip decision only needs the key.
  const collisionByTaxPath = new Map<string, typeof collisions>();
  for (const col of collisions) {
    let arr = collisionByTaxPath.get(col.taxPath);
    if (!arr) {
      arr = [];
      collisionByTaxPath.set(col.taxPath, arr);
    }
    arr.push(col);
  }
  for (const col of collisions) {
    nameCollisions.push(col);
    Zotero.debug(
      `[SmartOrganizer] Name collision: taxonomy path "${col.taxPath}" ` +
        `(leaf "${col.taxLeafName}") conflicts with existing collection at ` +
        `"${col.existingPath}"; skipping creation.`,
    );
  }

  // Track newly created collection IDs so we don't delete them in cleanup.
  const newCollectionIDs = new Set<number>();

  // Walk taxonomy depth-first, parents before children.
  const createStack: { node: TaxonomyNode; parentID: number | false }[] = [];
  for (let i = plan.taxonomy.length - 1; i >= 0; i--) {
    createStack.push({ node: plan.taxonomy[i], parentID: false });
  }
  let collectionsProcessed = 0;
  while (createStack.length > 0) {
    const { node, parentID } = createStack.pop()!;
    collectionsProcessed++;
    options.onProgress?.({
      phase: "collections",
      message: `Creating collections… (${collectionsProcessed}/${totalPaths})`,
      current: collectionsProcessed,
      total: totalPaths,
    });
    let id = pathToID.get(node.path);
    if (id === undefined) {
      // Collision guard: if this node's leaf name collides with an existing
      // collection at a different path, refuse to create it. Creating it would
      // produce a same-named sibling under a different parent — the duplicate-
      // name bug. Skip this node and its subtree; items assigned under it will
      // fail to refile in Phase 2 with a clear "could not be resolved" error.
      if (collisionByTaxPath.has(node.path)) {
        errors.push({
          itemId: -1,
          error:
            `Skipped creating collection "${node.path}": its leaf name "` +
            `${leafNameOf(node.path)}" already exists as a collection at a ` +
            `different path. Edit the taxonomy to use a unique name.`,
        });
        // Do NOT set pathToID[node.path], so children and assignments under it
        // also fail to resolve. Skip the subtree entirely.
        continue;
      }
      // Create the collection.
      try {
        const collection = new Zotero.Collection({
          libraryID: USER_LIBRARY_ID,
          name: node.name,
          // parentID: number for nested, 0 for top-level (collection.d.ts:27).
          parentID: parentID === false ? 0 : parentID,
        });
        const saved = await collection.saveTx();
        // Use the numeric id, NEVER .key (work-order safety rule #2).
        // saveTx returns the new id (dataObjects.d.ts:233) but the object is
        // also populated; prefer the object's id which is always numeric.
        id = typeof saved === "number" ? saved : collection.id;
        pathToID.set(node.path, id);
        newCollectionIDs.add(id);
        collectionsCreated++;
        Zotero.debug(
          `[SmartOrganizer] applyPlan: created collection "${node.path}" (id=${id}, parentID=${parentID === false ? 0 : parentID})`,
        );
      } catch (e) {
        Zotero.debug(
          `[SmartOrganizer] applyPlan: FAILED to create collection "${node.path}": ${e}`,
        );
        // If we cannot create a collection, every item assigned under it will
        // fail to refile; record a synthetic error per affected item later.
        errors.push({
          itemId: -1,
          error: `Failed to create collection "${node.path}": ${(e as Error).message ?? String(e)}`,
        });
        // Continue with children — they may still be creatable if the parent
        // already existed via a different path match. Mark this path as
        // unresolvable by simply not setting pathToID.
      }
    }

    // Push children (in reverse so they're processed in document order).
    for (let i = node.children.length - 1; i >= 0; i--) {
      createStack.push({
        node: node.children[i],
        parentID: id !== undefined ? id : false,
      });
    }
  }

  Zotero.debug(
    `[SmartOrganizer] applyPlan: Phase 1 complete — ${collectionsCreated} collections created, ${pathToID.size} paths resolvable`,
  );

  // Phase 2: refile items.
  Zotero.debug(
    `[SmartOrganizer] applyPlan: Phase 2 — refile ${plan.assignments.length} items`,
  );
  const totalAssignments = plan.assignments.length;
  let itemsProcessed = 0;
  for (const assignment of plan.assignments) {
    itemsProcessed++;
    if (itemsProcessed % 10 === 0 || itemsProcessed === totalAssignments) {
      options.onProgress?.({
        phase: "refiling",
        message: `Refiling items… (${itemsProcessed}/${totalAssignments})`,
        current: itemsProcessed,
        total: totalAssignments,
      });
    }
    try {
      // Skip items with no assigned paths (unfiled in the plan).
      if (assignment.collectionPaths.length === 0) {
        continue;
      }
      const item = Zotero.Items.get(assignment.itemId);
      if (!item || item.deleted) {
        Zotero.debug(
          `[SmartOrganizer] applyPlan: item ${assignment.itemId} not found or trashed; recording error`,
        );
        errors.push({
          itemId: assignment.itemId,
          error: "item not found or trashed",
        });
        continue;
      }

      const newIDs: number[] = [];
      for (const p of assignment.collectionPaths) {
        const cid = pathToID.get(p);
        if (cid !== undefined) {
          newIDs.push(cid);
        } else {
          errors.push({
            itemId: assignment.itemId,
            error: `collection path "${p}" could not be resolved`,
          });
        }
      }
      if (newIDs.length === 0) {
        continue;
      }

      let finalIDs: number[];
      if (options.replaceExisting) {
        // Destructive: replace with the new IDs only.
        finalIDs = dedupeSorted(newIDs);
      } else {
        // Additive: union with current IDs.
        const current = (item.getCollections() ?? []).slice();
        finalIDs = dedupeSorted([...current, ...newIDs]);
      }
      item.setCollections(finalIDs);
      await item.saveTx();
      itemsRefiled++;
      Zotero.debug(
        `[SmartOrganizer] applyPlan: refiled item ${assignment.itemId} -> [${finalIDs.join(", ")}]`,
      );
      await delay(ITEM_DELAY_MS);
    } catch (e) {
      Zotero.debug(
        `[SmartOrganizer] applyPlan: error refiling item ${assignment.itemId}: ${e}`,
      );
      errors.push({
        itemId: assignment.itemId,
        error: (e as Error).message ?? String(e),
      });
    }
  }

  Zotero.debug(
    `[SmartOrganizer] applyPlan: Phase 2 complete — ${itemsRefiled} items refiled, ${errors.length} errors so far`,
  );

  // Phase 3: Delete old collections that are now empty (only in replace mode).
  let collectionsDeleted = 0;
  if (options.replaceExisting) {
    Zotero.debug(
      `[SmartOrganizer] applyPlan: Phase 3 — cleanup empty pre-existing collections (replace mode)`,
    );
    options.onProgress?.({
      phase: "cleanup",
      message: `Cleaning up empty collections…`,
      current: 0,
      total: 1,
    });
    // Get all collections in the library after re-filing.
    const allCollections = await Zotero.Collections.getByLibrary(
      USER_LIBRARY_ID,
      true,
    ) as any[];

    // Delete from deepest to shallowest so parent collections aren't deleted
    // before we check their children.
    // Sort by depth (path length) descending — approximate by parentID chain.
    const collectionDepth = (col: any): number => {
      let depth = 0;
      let current = col;
      while (current && current.parentID) {
        depth++;
        const parent = allCollections.find((c) => c.id === current.parentID);
        if (!parent) break;
        current = parent;
      }
      return depth;
    };
    allCollections.sort((a, b) => collectionDepth(b) - collectionDepth(a));

    for (const col of allCollections) {
      // Skip collections that were just created (they're in the new taxonomy).
      if (newCollectionIDs.has(col.id)) continue;
      if (col.deleted) continue;

      try {
        // Check if this collection has any items (directly or via children).
        // getChildItems/getChildCollections may throw UnloadedDataException
        // if the collection's child data hasn't been loaded from the DB.
        // Wrap each call in try/catch and skip if we can't check.
        let childItemIDs: number[] = [];
        let childCollections: number[] = [];
        try {
          childItemIDs = col.getChildItems ? (col.getChildItems(true) as number[]) : [];
        } catch {
          Zotero.debug(`[SmartOrganizer] Could not load child items for collection ${col.id}, skipping.`);
          continue;
        }
        if (childItemIDs.length > 0) continue;

        try {
          childCollections = col.getChildCollections ? (col.getChildCollections(true) as number[]) : [];
        } catch {
          Zotero.debug(`[SmartOrganizer] Could not load child collections for collection ${col.id}, skipping.`);
          continue;
        }
        if (childCollections.length > 0) continue;

        // This collection is empty and has no children — delete it.
        await col.eraseTx();
        collectionsDeleted++;
        Zotero.debug(
          `[SmartOrganizer] applyPlan: deleted empty collection "${col.name}" (id=${col.id})`,
        );
      } catch (e) {
        // Collection data might not be loaded — try to load it first.
        Zotero.debug(`[SmartOrganizer] applyPlan: failed to check/delete collection ${col.id}: ${e}`);
      }
    }
  } else {
    Zotero.debug(
      `[SmartOrganizer] applyPlan: Phase 3 skipped (replaceExisting=false)`,
    );
  }

  const result: ApplyResult = {
    collectionsCreated,
    itemsRefiled,
    collectionsDeleted,
    errors,
    nameCollisions,
  };
  Zotero.debug(
    `[SmartOrganizer] applyPlan: exit — ${result.collectionsCreated} created, ` +
      `${result.itemsRefiled} refiled, ${result.collectionsDeleted} deleted, ` +
      `${result.errors.length} errors, ${result.nameCollisions.length} collisions`,
  );
  return result;
}

/**
 * Given a taxonomy and the set of existing collection paths (slash-delimited,
 * root-to-leaf, matching `TaxonomyNode.path` format), return which paths need
 * to be created vs which can be reused.
 *
 * Pure: no Zotero globals, no I/O. The taxonomy is flattened depth-first
 * (parent before child, via `flattenTaxonomyPaths`); a path is "to reuse" if
 * it already exists in `existingPaths`, "to create" otherwise. The returned
 * `toCreate` is in dependency order (parents before children) so a caller
 * creating them in order will always know the parent ID.
 */
export function planCollectionCreation(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { toCreate: string[]; toReuse: string[] } {
  // Pure helper, also unit-tested under plain Node where Zotero is undefined;
  // guard the debug call so it is a no-op outside the plugin sandbox.
  (globalThis as any).Zotero?.debug?.(
    `[SmartOrganizer] planCollectionCreation: entry — ${flattenPaths(taxonomy).length} taxonomy paths, ${existingPaths.length} existing`,
  );
  const existing = new Set(existingPaths);
  const all = flattenPaths(taxonomy);
  const toCreate: string[] = [];
  const toReuse: string[] = [];
  for (const p of all) {
    if (existing.has(p)) {
      toReuse.push(p);
    } else {
      toCreate.push(p);
    }
  }
  (globalThis as any).Zotero?.debug?.(
    `[SmartOrganizer] planCollectionCreation: exit — ${toCreate.length} to create, ${toReuse.length} to reuse`,
  );
  return { toCreate, toReuse };
}

/**
 * Flatten a taxonomy tree into the list of every path it contains (root and
 * leaf, all depths), depth-first parent-before-child. This mirrors
 * `planValidator.flattenTaxonomyPaths` but is inlined here so this module has
 * no relative runtime imports — only type-only imports (erased by
 * `--experimental-strip-types`), which keeps `planCollectionCreation` unit-
 * testable under plain Node.
 */
function flattenPaths(roots: TaxonomyNode[]): string[] {
  const out: string[] = [];
  const stack: TaxonomyNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n.path);
    for (let i = n.children.length - 1; i >= 0; i--) {
      stack.push(n.children[i]);
    }
  }
  return out;
}

/**
 * Return the leaf-name component of a slash-delimited collection path (the
 * substring after the last '/'). A path with no '/' returns itself. Mirrors the
 * private `leafNameOf` in `planValidator.ts`; kept local so this module's pure
 * helper (`planCollectionCreation`) stays free of relative runtime imports.
 */
function leafNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Detect leaf-name collisions between a proposed taxonomy and the EXISTING
 * library's collection paths (the `pathToID` map built in Phase 1) — the root
 * cause of the duplicate-collection-name bug.
 *
 * A collision is a taxonomy node the applier would have to CREATE (its full
 * path is NOT in `pathToID`, so `pathToID.get(node.path)` would be undefined)
 * AND whose LEAF name matches an existing collection's leaf name. In the
 * create loop such a node would silently create a brand-new same-named
 * collection under a different parent, leaving the library with two distinct
 * collections that share a name but hold different papers.
 *
 * A taxonomy node whose full path EXACTLY matches an existing path is a REUSE
 * (the applier will reuse the existing collection) and is never reported.
 *
 * This is a private local mirror of `planValidator.findExistingNameCollisions`
 * (kept local so this module has no relative runtime imports, preserving
 * `planCollectionCreation`'s plain-Node unit-testability under
 * `--experimental-strip-types`). Pure: no Zotero globals, no I/O.
 */
function findLocalNameCollisions(
  taxonomy: TaxonomyNode[],
  pathToID: Map<string, number>,
): { taxPath: string; taxLeafName: string; existingPath: string }[] {
  const existingByLeaf = new Map<string, string[]>();
  for (const p of pathToID.keys()) {
    const leaf = leafNameOf(p);
    let arr = existingByLeaf.get(leaf);
    if (!arr) {
      arr = [];
      existingByLeaf.set(leaf, arr);
    }
    arr.push(p);
  }
  const out: { taxPath: string; taxLeafName: string; existingPath: string }[] =
    [];
  for (const taxPath of flattenPaths(taxonomy)) {
    // Reuse: the applier will reuse the existing collection at this exact path,
    // so no new same-named collection would be created. Skip.
    if (pathToID.has(taxPath)) {
      continue;
    }
    const leaf = leafNameOf(taxPath);
    const candidates = existingByLeaf.get(leaf);
    if (!candidates) {
      continue;
    }
    // taxPath is not in pathToID, so every candidate path differs from it.
    for (const existingPath of candidates) {
      out.push({ taxPath, taxLeafName: leaf, existingPath });
    }
  }
  return out;
}

/**
 * Build the slash-delimited path of an EXISTING collection by walking
 * `parentID` up to the root. Mirrors `collectionTree.ts`'s `buildCollectionPath`
 * but operates directly on `Zotero.Collection` objects (which we already have
 * in hand during apply, so no separate lookup closure is needed).
 *
 * Returns `""` if a parent is missing from `existingByID` (stale membership).
 */
function buildExistingPath(
  col: Zotero.Collection,
  existingByID: Map<number, Zotero.Collection>,
): string {
  const names: string[] = [];
  let current: Zotero.Collection | undefined = col;
  const visited = new Set<number>();
  while (current) {
    if (visited.has(current.id)) {
      break; // defensive against cycles
    }
    visited.add(current.id);
    names.unshift(current.name);
    const pid = current.parentID;
    if (!pid) {
      break;
    }
    current = existingByID.get(pid);
  }
  return names.join("/");
}

/**
 * Return a sorted, de-duplicated copy of `ids`. Numeric IDs only. Used to
 * normalize collection ID lists before `setCollections`.
 */
function dedupeSorted(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-exported type so callers (the UI) can import the assignment type from one
 * place. Documented re-export; does not modify Gate 1–3 source files.
 */
export type { ItemAssignment };
