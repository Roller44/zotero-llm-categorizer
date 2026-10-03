/**
 * Orchestrator for the two-stage LLM categorization pipeline (Gate 3).
 *
 * `generatePlan()` reads the library via Gate 2's `readLibrary()` (read-only),
 * proposes a taxonomy (Stage 1), classifies every item into it (Stage 2),
 * computes summary stats, and returns a `CategorizationPlan` — a pure data
 * object. It performs NO writes to the Zotero database, NO transactional
 * saves, NO collection creation, NO tag changes. Gate 4's review UI will
 * consume this plan.
 *
 * `generatePlanSummary()` renders a plan as a human-readable string for the
 * debug log (and, later, for the review UI's header).
 */

import { config } from "../../package.json";
import { readLibrary } from "./libraryReader";
import { proposeTaxonomy, sampleForTaxonomy } from "./taxonomyStage";
import { classifyItems, DEFAULT_BATCH_SIZE } from "./classificationStage";
import { flattenTaxonomyPaths } from "./planValidator";
import type { ChunkCallback } from "./llmClient";
import type {
  CategorizationPlan,
  ItemAssignment,
  TaxonomyNode,
} from "./categorizationTypes";

/**
 * Progress callback invoked during `generatePlan` to report milestones.
 * `stage` is "reading", "taxonomy", "classifying", "reasoning", or "done". For
 * "classifying", `current` and `total` report batch progress. For "reasoning",
 * `detail` carries the latest LLM thinking-trace delta.
 */
export interface ProgressUpdate {
  stage: "reading" | "taxonomy" | "classifying" | "done" | "reasoning";
  message: string;
  /** Longer detail line for the log panel (e.g. what the LLM returned). */
  detail?: string;
  current?: number;
  total?: number;
}

/**
 * Run the full two-stage pipeline against the live library and return a
 * reviewable plan. Reads only (via Gate 2); writes nothing.
 *
 * @param onProgress optional callback for progress updates (e.g. to update a
 *   ProgressWindow in the UI). Called synchronously at each milestone.
 */
export async function generatePlan(
  onProgress?: (update: ProgressUpdate) => void,
): Promise<CategorizationPlan> {
  onProgress?.({ stage: "reading", message: "Reading library…" });

  const items = await readLibrary();
  onProgress?.({
    stage: "reading",
    message: `Read ${items.length} items from library.`,
  });

  const sample = sampleForTaxonomy(items);
  onProgress?.({
    stage: "taxonomy",
    message: `Proposing taxonomy from ${sample.length} sampled items…`,
    detail: `Stage 1: Sending ${sample.length} item titles + venues to the LLM to propose a hierarchical taxonomy (8–15 areas, max depth 3). This is 1 API call.`,
  });

  // Build the onChunk callback that surfaces LLM reasoning deltas to the
  // progress UI. Content chunks are accumulated internally by chatComplete and
  // can be ignored here.
  const onChunk: ChunkCallback = (kind, text) => {
    if (kind === "reasoning") {
      onProgress?.({
        stage: "reasoning",
        message: "LLM is reasoning…",
        detail: text,
      });
    }
  };

  const taxonomy = await proposeTaxonomy(items, (taxDetail) => {
    onProgress?.({
      stage: "taxonomy",
      message: `Proposing taxonomy…`,
      detail: taxDetail,
    });
  }, onChunk);

  const allPaths = flattenTaxonomyPaths(taxonomy);
  onProgress?.({
    stage: "taxonomy",
    message: `Taxonomy ready: ${allPaths.length} collections in ${taxonomy.length} top-level areas.`,
    detail: `Stage 1 complete. Proposed top-level areas:\n${taxonomy.map((t) => `  • ${t.name} — ${t.description}`).join("\n")}`,
  });

  const totalBatches = Math.ceil(items.length / DEFAULT_BATCH_SIZE);
  onProgress?.({
    stage: "classifying",
    message: `Classifying ${items.length} items in ${totalBatches} batches…`,
    detail: `Stage 2: Each batch sends ~${DEFAULT_BATCH_SIZE} items to the LLM with the full taxonomy. Running 3 batches concurrently. This is ~${totalBatches} API calls.`,
    current: 0,
    total: totalBatches,
  });

  const assignments = await classifyItems(items, taxonomy, {
    onBatchDone: (done, total, batchDetail) => {
      onProgress?.({
        stage: "classifying",
        message: `Classifying items… (${done}/${total} batches done)`,
        detail: batchDetail,
        current: done,
        total,
      });
    },
    onChunk,
  });

  onProgress?.({
    stage: "done",
    message: "Plan complete.",
    detail: `Categorization finished. ${assignments.filter((a) => a.collectionPaths.length > 0).length} of ${items.length} items assigned to collections.`,
  });

  const stats = computeStats(items.length, taxonomy, assignments);

  const model =
    (Zotero.Prefs.get(`${config.prefsPrefix}.model`, true) as
      | string
      | undefined) || "(unknown)";

  return {
    taxonomy,
    assignments,
    stats,
    model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Compute the summary stats block of a `CategorizationPlan`. Pure.
 */
export function computeStats(
  totalItems: number,
  taxonomy: TaxonomyNode[],
  assignments: ItemAssignment[],
): CategorizationPlan["stats"] {
  const itemsWithAssignment = assignments.filter(
    (a) => a.collectionPaths.length > 0,
  ).length;
  const allPaths = flattenTaxonomyPaths(taxonomy);
  return {
    totalItems,
    itemsWithAssignment,
    itemsUnfiled: totalItems - itemsWithAssignment,
    totalCollections: allPaths.length,
    topLevelCollections: taxonomy.length,
  };
}

/**
 * Render a `CategorizationPlan` as a human-readable summary string for the
 * debug log. Includes the taxonomy tree (indented), unfiled count, and the
 * top 5 collection paths by item count. Pure (no Zotero globals).
 */
export function generatePlanSummary(plan: CategorizationPlan): string {
  const lines: string[] = [];
  lines.push(
    `Smart Organizer categorization plan — generated ${plan.generatedAt}`,
  );
  lines.push(
    `Model: ${plan.model} | Items: ${plan.stats.totalItems} | ` +
      `Assigned: ${plan.stats.itemsWithAssignment} | ` +
      `Unfiled: ${plan.stats.itemsUnfiled} | ` +
      `Collections: ${plan.stats.totalCollections} ` +
      `(${plan.stats.topLevelCollections} top-level)`,
  );
  lines.push("");
  lines.push("Proposed taxonomy:");
  for (const root of plan.taxonomy) {
    lines.push(renderNode(root, 0));
  }

  // Top 5 paths by item count.
  const counts = new Map<string, number>();
  for (const a of plan.assignments) {
    for (const p of a.collectionPaths) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 5);
  lines.push("");
  lines.push("Top 5 collection paths by item count:");
  if (top.length === 0) {
    lines.push("  (no assignments)");
  } else {
    for (const t of top) {
      lines.push(`  ${t.count}\t${t.path}`);
    }
  }
  return lines.join("\n");
}

function renderNode(node: TaxonomyNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const head = `${indent}- ${node.name} (${node.path})`;
  const desc = node.description ? ` — ${node.description}` : "";
  const children = node.children
    .map((c) => renderNode(c, depth + 1))
    .join("\n");
  return children ? `${head}${desc}\n${children}` : `${head}${desc}`;
}

// Re-exported for callers (e.g. a future Gate 4 UI) that want to drive the
// stages individually or inspect the sampling. Documented re-export of pure
// helpers; does not modify Gate 1 or Gate 2.
export { sampleForTaxonomy };
