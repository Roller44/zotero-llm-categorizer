/**
 * Shared data model for the two-stage LLM categorization pipeline (Gate 3).
 *
 * This module contains ONLY TypeScript interfaces (plus no runtime logic) so it
 * can be imported by both the pure, no-Zotero, no-network logic
 * (`promptBuilder.ts`, `planValidator.ts`) and the orchestration modules that
 * DO touch Zotero / the LLM (`taxonomyStage.ts`, `classificationStage.ts`,
 * `categorizer.ts`). It deliberately has no relative imports.
 *
 * Nothing in this gate writes to the Zotero database or creates collections.
 * The `CategorizationPlan` produced here is consumed by Gate 4's review UI.
 */

/**
 * A node in the proposed taxonomy tree.
 *
 * `path` is the unique key (slash-delimited from root, e.g.
 * `"SemanticComm/JSCC/Analog"`). `children` is empty for leaf collections.
 */
export interface TaxonomyNode {
  /** Human-readable collection name, e.g. "SemanticComm". */
  name: string;
  /** Full path from root, e.g. "SemanticComm/JSCC/Analog". Unique key. */
  path: string;
  /** Child nodes. Empty for leaf collections. */
  children: TaxonomyNode[];
  /** One-sentence description of what belongs here (from the LLM). */
  description: string;
}

/**
 * One item's assignment in the plan.
 *
 * `itemId` matches `LibraryItem.id`. An item may belong to multiple
 * collections; `collectionPaths` lists them. `confidence` is a heuristic
 * derived from the LLM's own stated confidence and whether any of its paths
 * survived validation.
 */
export interface ItemAssignment {
  /** The LibraryItem.id this assignment is for. */
  itemId: number;
  /** The item's title (for the review UI; not used for logic). */
  title: string;
  /** Proposed collection paths. An item may belong to multiple. */
  collectionPaths: string[];
  /** Whether the LLM was confident (heuristic: low temperature + explicit match). */
  confidence: "high" | "medium" | "low";
}

/**
 * The full output of the categorization pipeline. Gate 4 renders this object
 * in a review UI; nothing here is applied to the library.
 */
export interface CategorizationPlan {
  /** The proposed taxonomy tree (root nodes). */
  taxonomy: TaxonomyNode[];
  /** Per-item assignments. Length = number of items read. */
  assignments: ItemAssignment[];
  /** Stats for the review UI. */
  stats: {
    totalItems: number;
    itemsWithAssignment: number;
    itemsUnfiled: number;
    totalCollections: number;
    topLevelCollections: number;
  };
  /** The LLM model used, for reproducibility. */
  model: string;
  /** ISO timestamp of when the plan was generated. */
  generatedAt: string;
}
