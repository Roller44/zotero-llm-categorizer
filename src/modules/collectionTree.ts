/**
 * Pure, dependency-free helper for building the full slash-delimited path of a
 * Zotero collection by walking `parentID` up to the root.
 *
 * This module contains NO Zotero globals and NO config imports so it can be
 * unit-tested under plain Node without a Zotero sandbox. `libraryReader.ts`
 * supplies a `lookup` closure that resolves a collection ID to a
 * `CollectionNode` via `Zotero.Collections.get(id)`.
 */

export interface CollectionNode {
  id: number;
  name: string;
  parentID: number | false;
}

/**
 * Build the full path (e.g. `"SemanticComm/JSCC/Analog"`) for a collection by
 * walking `parentID` from the given collection up to the root, joining names
 * in root -> leaf order.
 *
 * @param collectionID  the collection whose path to build
 * @param lookup         resolves a collection ID to a `CollectionNode`
 * @returns the path string, or `""` if `lookup(collectionID)` is undefined
 *          (the collection no longer exists — possible with stale memberships)
 * @throws if a parent cycle is detected (defensive; should never happen in
 *         Zotero, but a corrupted membership graph could otherwise loop forever)
 */
export function buildCollectionPath(
  collectionID: number,
  lookup: (id: number) => CollectionNode | undefined,
): string {
  const start = lookup(collectionID);
  if (!start) {
    return "";
  }

  const names: string[] = [];
  let current: CollectionNode | undefined = start;
  const visited = new Set<number>();

  while (current) {
    if (visited.has(current.id)) {
      throw new Error(
        `Collection path cycle detected at collectionID ${current.id}`,
      );
    }
    visited.add(current.id);
    names.unshift(current.name);

    const parentID = current.parentID;
    if (parentID === false || parentID === 0) {
      break;
    }
    current = lookup(parentID);
  }

  return names.join("/");
}
