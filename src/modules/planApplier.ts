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
}

/**
 * Result of an apply. Counts plus a per-item error list so the UI can show
 * partial-failure details without losing the successes.
 */
export interface ApplyResult {
  collectionsCreated: number;
  itemsRefiled: number;
  collectionsDeleted: number;
  errors: { itemId: number; error: string }[];
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
  const errors: { itemId: number; error: string }[] = [];
  let collectionsCreated = 0;
  let itemsRefiled = 0;

  // Phase 1: resolve / create collections. path -> numeric collectionID.
  const pathToID = new Map<string, number>();

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
  for (const c of existingCols) {
    const path = buildExistingPath(c, existingByID);
    if (path) {
      pathToID.set(path, c.id);
    }
  }

  // Track newly created collection IDs so we don't delete them in cleanup.
  const newCollectionIDs = new Set<number>();

  // Walk taxonomy depth-first, parents before children.
  const createStack: { node: TaxonomyNode; parentID: number | false }[] = [];
  for (let i = plan.taxonomy.length - 1; i >= 0; i--) {
    createStack.push({ node: plan.taxonomy[i], parentID: false });
  }
  while (createStack.length > 0) {
    const { node, parentID } = createStack.pop()!;
    let id = pathToID.get(node.path);
    if (id === undefined) {
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
      } catch (e) {
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

  // Phase 2: refile items.
  for (const assignment of plan.assignments) {
    try {
      // Skip items with no assigned paths (unfiled in the plan).
      if (assignment.collectionPaths.length === 0) {
        continue;
      }
      const item = Zotero.Items.get(assignment.itemId);
      if (!item || item.deleted) {
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
      await delay(ITEM_DELAY_MS);
    } catch (e) {
      errors.push({
        itemId: assignment.itemId,
        error: (e as Error).message ?? String(e),
      });
    }
  }

  // Phase 3: Delete old collections that are now empty (only in replace mode).
  let collectionsDeleted = 0;
  if (options.replaceExisting) {
    // Get all collections in the library after re-filing.
    const allCollections = await Zotero.Collections.getByLibrary(USER_LIBRARY_ID);
    for (const col of allCollections) {
      // Skip collections that were just created (they're in the new taxonomy).
      if (newCollectionIDs.has(col.id)) continue;
      // Check if this collection has any items.
      const childItems = col.getChildItems ? col.getChildItems() : [];
      const descendantItems = childItems.length;
      // Also check subcollections recursively — if a collection has no items
      // and no subcollections with items, it's empty.
      const hasNonEmptyDescendant = (collection: any): boolean => {
        const items = collection.getChildItems ? collection.getChildItems() : [];
        if (items.length > 0) return true;
        const children = collection.getChildCollections ? collection.getChildCollections() : [];
        for (const child of children) {
          if (hasNonEmptyDescendant(child)) return true;
        }
        return false;
      };
      if (!hasNonEmptyDescendant(col)) {
        try {
          await col.eraseTx();
          collectionsDeleted++;
        } catch (e) {
          // Don't fail the whole apply if a collection can't be deleted.
          Zotero.debug(`[SmartOrganizer] Failed to delete empty collection ${col.id}: ${e}`);
        }
      }
    }
  }

  return { collectionsCreated, itemsRefiled, collectionsDeleted, errors };
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
