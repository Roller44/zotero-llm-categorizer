/**
 * Stage 2 of the two-stage LLM categorization pipeline (Gate 3): classify each
 * item into the taxonomy proposed by Stage 1.
 *
 * To avoid hundreds of individual LLM calls, items are batched (default 20 per
 * call) and the batches are run concurrently with a small cap (default 3) to
 * stay within typical provider rate limits. Each batch's JSON response is
 * validated with up to `MAX_RETRIES` retries; assignment paths that do not
 * exist in the taxonomy are dropped (with a warning logged), never thrown —
 * the plan must remain usable even if the LLM hallucinates a path.
 *
 * This module performs NO Zotero reads (it consumes `LibraryItem[]` from Gate
 * 2) and NO writes of any kind.
 */

import type { LibraryItem } from "./libraryModel";
import type { ItemAssignment, TaxonomyNode } from "./categorizationTypes";
import {
  chatComplete,
  safeGetPref,
  type ChatMessage,
  type ChunkCallback,
} from "./llmClient";
import { config } from "../../package.json";
import {
  buildClassificationPrompt,
  buildRetryPrompt,
} from "./promptBuilder";
import {
  extractJson,
  flattenTaxonomyPaths,
  validateAssignments,
} from "./planValidator";

/** Default number of items per classification LLM call. Tunable. */
export const DEFAULT_BATCH_SIZE = 10;

/** Maximum concurrent batch LLM calls. Tunable; keeps us under rate limits. */
export const DEFAULT_CONCURRENCY = 5;

/** Maximum retry attempts per batch after a malformed LLM response. */
const MAX_RETRIES = 2;

/**
 * Split `items` into consecutive batches of `size`. Pure, exported for
 * testability.
 */
export function batchItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`batch size must be > 0, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run async tasks with a concurrency cap. Resolves in the order tasks
 * complete; returns results in the INPUT order. Simple semaphore pattern.
 */
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  if (limit <= 0) {
    throw new Error(`concurrency must be > 0, got ${limit}`);
  }
  const results: O[] = new Array(items.length);
  let next = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    const launch = () => {
      while (active < limit && next < items.length) {
        const idx = next++;
        active++;
        worker(items[idx], idx)
          .then((r) => {
            results[idx] = r;
          })
          .catch(reject)
          .finally(() => {
            active--;
            if (next < items.length) {
              // Yield to the UI macrotask queue between batch completions so
              // the host can process paint/input events for large libraries.
              setTimeout(launch, 0);
            } else if (active === 0) {
              resolve(results);
            }
          });
      }
    };
    if (items.length === 0) {
      resolve(results);
    } else {
      launch();
    }
  });
}

/**
 * Classify one batch: build the prompt, call the LLM, validate the response
 * with retries. Returns the validated `ItemAssignment[]` plus any paths the
 * LLM produced that were not in the taxonomy (so the caller can log them).
 */
async function classifyBatch(
  batch: LibraryItem[],
  validPaths: Set<string>,
  onChunk?: ChunkCallback,
): Promise<{ assignments: ItemAssignment[]; droppedPaths: string[] }> {
  const customPrompt = safeGetPref(
    `${config.prefsPrefix}.classificationSystemPrompt`,
  );
  const { system, user } = buildClassificationPrompt(
    batch,
    [...validPaths],
    customPrompt.trim() || undefined,
  );

  let messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const raw = await chatComplete(messages, { temperature: 0 }, onChunk);
    const extracted = extractJson(raw);
    if (!extracted.ok) {
      lastError = extracted.error;
    } else {
      const validated = validateAssignments(extracted.value, validPaths);
      if (validated.ok) {
        return {
          assignments: validated.value,
          droppedPaths: validated.droppedPaths,
        };
      }
      lastError = validated.error;
    }

    if (attempt < MAX_RETRIES) {
      const retry = buildRetryPrompt(lastError);
      messages = [
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: retry.user },
      ];
    }
  }

  throw new Error(
    `Classification batch failed after ${MAX_RETRIES} retries. Last error: ${lastError}`,
  );
}

/**
 * Classify every item in `items` against `taxonomy`.
 *
 * Items are batched (default `DEFAULT_BATCH_SIZE`) and batches run concurrently
 * (default `DEFAULT_CONCURRENCY`). Every assignment path is checked against
 * the taxonomy's flat path list; invalid paths are dropped and a warning is
 * logged via `Zotero.debug` (when available). An item that ends up with zero
 * valid paths is returned with `confidence: "low"` and `collectionPaths: []`.
 */
export async function classifyItems(
  items: LibraryItem[],
  taxonomy: TaxonomyNode[],
  options: {
    batchSize?: number;
    concurrency?: number;
    onBatchDone?: (
      completed: number,
      total: number,
      detail: string,
    ) => void;
    onChunk?: ChunkCallback;
  } = {},
): Promise<ItemAssignment[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const onBatchDone = options.onBatchDone;
  const onChunk = options.onChunk;
  const paths = flattenTaxonomyPaths(taxonomy);
  const validPaths = new Set(paths);

  const batches = batchItems(items, batchSize);
  let batchesCompleted = 0;
  const batchResults = await mapWithConcurrency(
    batches,
    concurrency,
    async (b, batchIdx) => {
      const result = await classifyBatch(b, validPaths, onChunk);
      batchesCompleted++;
      const itemTitles = b
        .slice(0, 3)
        .map((it) => it.title.slice(0, 60))
        .join("; ");
      const detail =
        `Batch ${batchIdx + 1}/${batches.length}: classified ${b.length} items ` +
        `(${result.assignments.length} assignments` +
        (result.droppedPaths.length > 0
          ? `, ${result.droppedPaths.length} invalid paths dropped`
          : "") +
        `). Sample: ${itemTitles}…`;
      onBatchDone?.(batchesCompleted, batches.length, detail);
      return result;
    },
  );

  // Index items by id so we can attach titles to assignments even if the LLM
  // omits them or returns them out of order.
  const titleById = new Map<number, string>();
  for (const it of items) {
    titleById.set(it.id, it.title);
  }

  const assignments: ItemAssignment[] = [];
  for (const { assignments: batchAssignments, droppedPaths } of batchResults) {
    if (droppedPaths.length > 0) {
      try {
        Zotero?.debug?.(
          `[SmartOrganizer] classification: dropped ${droppedPaths.length} ` +
            `invalid path(s): ${droppedPaths.slice(0, 10).join(", ")}` +
            (droppedPaths.length > 10 ? " …" : ""),
        );
      } catch {
        // Zotero global unavailable (e.g. in a pure-Node test harness) — ignore.
      }
    }
    for (const a of batchAssignments) {
      const title = a.title || titleById.get(a.itemId) || "";
      assignments.push({
        itemId: a.itemId,
        title,
        collectionPaths: a.collectionPaths,
        confidence: a.confidence,
      });
    }
  }
  return assignments;
}
