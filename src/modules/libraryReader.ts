/**
 * Read-only library reader for the Zotero Smart Organizer.
 *
 * Loads every regular (non-trashed, non-attachment, non-note) item in the
 * user's Zotero library plus its metadata and current collection memberships
 * into an in-memory `LibraryItem[]` that Gate 3's categorization stage will
 * consume.
 *
 * This module is READ-ONLY. It performs NO writes to `zotero.sqlite`, NO
 * `saveTx`, NO LLM calls, NO categorization, and NO collection creation. It
 * reads exclusively through the Zotero JS API (`Zotero.Items.getAll(1)`,
 * `Zotero.Collections.get(id)`, and the `Zotero.Item` field accessors).
 *
 * Collection membership is obtained via `item.getCollections()` — confirmed
 * against the `zotero-types` type definitions
 * (node_modules/zotero-types/types/xpcom/data/item.d.ts):
 *   `getCollections(): number[];`  (line 987, also 412)
 * Each returned collection ID is resolved with `Zotero.Collections.get(id)`
 * (from `DataObjects.get(id: number): T`, dataObjects.d.ts:26) and its full
 * path is built by the pure `buildCollectionPath` helper in `collectionTree.ts`.
 *
 * The pure data model + serialization live in `libraryModel.ts` (no Zotero
 * globals, no relative imports) so they can be unit-tested under plain Node.
 */

import {
  buildCollectionPath,
  type CollectionNode,
} from "./collectionTree";
import {
  type LibraryItem,
  type LibrarySummary,
  serializeLibrary,
  summarizeLibrary,
} from "./libraryModel";

export type { LibraryItem, LibrarySummary };
export { serializeLibrary, summarizeLibrary };

/**
 * Coerce a `getField` result (string | undefined | null) to a string, never
 * throwing on a missing field.
 */
function field(value: string | undefined | null): string {
  return value == null ? "" : String(value);
}

/**
 * Read all regular, non-trashed items from the user library (libraryID `1`)
 * and map them to the `LibraryItem` in-memory model.
 *
 * Missing metadata fields are returned as empty strings; an item in no
 * collections has `collectionPaths: []`.
 */
export async function readLibrary(): Promise<LibraryItem[]> {
  const all = (await Zotero.Items.getAll(1)) as Zotero.Item[];

  const items: LibraryItem[] = [];
  for (const item of all) {
    // Filter to regular, non-trashed items (papers/books), excluding
    // attachments and notes.
    if (!item.isRegularItem() || item.deleted) {
      continue;
    }

    const collectionPaths = resolveCollectionPaths(item);

    items.push({
      id: item.id,
      key: item.key,
      itemType: item.itemType,
      title: field(item.getField("title")),
      abstract: field(item.getField("abstractNote")),
      date: field(item.getField("date")),
      doi: field(item.getField("DOI")),
      publicationTitle: field(item.getField("publicationTitle")),
      creators: item.getCreatorsJSON().map((c) => ({
        firstName: c.firstName ?? "",
        lastName: c.lastName ?? "",
        creatorType: c.creatorType ?? "",
      })),
      tags: item.getTags().map((t) => t.tag),
      attachmentCount: item.getAttachments().length,
      collectionPaths,
    });
  }

  return items;
}

/**
 * Resolve an item's collection memberships to full slash-delimited paths.
 */
function resolveCollectionPaths(item: Zotero.Item): string[] {
  const collectionIDs: number[] = item.getCollections();
  if (!collectionIDs || collectionIDs.length === 0) {
    return [];
  }

  const lookup = (id: number): CollectionNode | undefined => {
    const col = Zotero.Collections.get(id);
    if (!col) {
      return undefined;
    }
    // parentID is typed as `number` on Zotero.Collection; a top-level
    // collection reports `0` (falsy). Normalize to `false` for the helper.
    const parentID = col.parentID || false;
    return { id: col.id, name: col.name, parentID };
  };

  const paths: string[] = [];
  for (const id of collectionIDs) {
    const path = buildCollectionPath(id, lookup);
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}
