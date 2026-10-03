/**
 * Pure, dependency-free data model + serialization for the in-memory library
 * representation.
 *
 * This module contains NO Zotero globals and NO relative imports so it can be
 * unit-tested under plain Node without a Zotero sandbox. `libraryReader.ts`
 * re-exports these and wraps them with the actual Zotero JS API reads.
 */

export interface LibraryItem {
  id: number; // itemID
  key: string; // 8-char key
  itemType: string; // 'journalArticle', 'preprint', 'book', ...
  title: string;
  abstract: string; // abstractNote
  date: string; // raw date string
  doi: string;
  publicationTitle: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  tags: string[]; // just the tag strings
  attachmentCount: number;
  collectionPaths: string[]; // e.g. ["SemanticComm/JSCC/Analog", "PureML/LLM"]
}

/**
 * Produce a stable JSON serialization (object keys sorted alphabetically,
 * recursively) of the item array. This is what Gate 3 will consume. Does NOT
 * write to disk.
 */
export function serializeLibrary(items: LibraryItem[]): string {
  return JSON.stringify(items, sortKeyReplacer, 2);
}

/**
 * JSON.stringify replacer that emits object keys in sorted order, recursively,
 * producing a stable serialization. Arrays are preserved as-is (order matters
 * for creators/tags/collectionPaths).
 */
function sortKeyReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

export interface LibrarySummary {
  total: number;
  withAbstract: number;
  withDoi: number;
  withTag: number;
  withAttachment: number;
  unfiled: number;
  topCollectionPaths: { path: string; count: number }[];
}

/**
 * Compute summary statistics from a `LibraryItem[]`. Pure function over the
 * in-memory model — no Zotero globals. Used by the debug entry point so the
 * same logic is testable without a Zotero sandbox.
 */
export function summarizeLibrary(items: LibraryItem[]): LibrarySummary {
  let withAbstract = 0;
  let withDoi = 0;
  let withTag = 0;
  let withAttachment = 0;
  let unfiled = 0;
  const pathCounts = new Map<string, number>();

  for (const it of items) {
    if (it.abstract) withAbstract++;
    if (it.doi) withDoi++;
    if (it.tags.length > 0) withTag++;
    if (it.attachmentCount > 0) withAttachment++;
    if (it.collectionPaths.length === 0) {
      unfiled++;
    } else {
      for (const p of it.collectionPaths) {
        pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
      }
    }
  }

  const topCollectionPaths = [...pathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 5);

  return {
    total: items.length,
    withAbstract,
    withDoi,
    withTag,
    withAttachment,
    unfiled,
    topCollectionPaths,
  };
}
