/**
 * Stage 1 of the two-stage LLM categorization pipeline (Gate 3): propose a
 * hierarchical taxonomy from a sample of the library.
 *
 * This module orchestrates an LLM call via Gate 1's `chatComplete()`. It
 * performs NO Zotero reads (the caller hands it `LibraryItem[]` from Gate 2's
 * `readLibrary()`) and NO writes of any kind. The taxonomy it returns is a
 * data object consumed by Stage 2 and ultimately Gate 4's review UI.
 *
 * Determinism: calls are made with `temperature: 0` for reproducibility (the
 * OpenAI-compatible path; Anthropic ignores this option, which is acceptable).
 */

import type { LibraryItem } from "./libraryModel";
import type { TaxonomyNode } from "./categorizationTypes";
import {
  chatComplete,
  safeGetPref,
  type ChatMessage,
  type ChunkCallback,
} from "./llmClient";
import { config } from "../../package.json";
import {
  buildRetryPrompt,
  buildTaxonomyPrompt,
  TAXONOMY_SAMPLE_LIMIT,
} from "./promptBuilder";
import { extractJson, validateTaxonomy } from "./planValidator";

/** Default number of items sampled for the taxonomy prompt. */
const DEFAULT_SAMPLE_SIZE = 150;

/** Maximum retry attempts after a malformed LLM response. */
const MAX_RETRIES = 2;

/**
 * Take a representative sample of up to `limit` items using a stratified
 * strategy: sort by the first (top-level) current collection so all existing
 * areas are represented, then take every Nth item. Items with no current
 * collection are sorted last but still sampled. If the library has `<= limit`
 * items, return them all (in original order).
 *
 * Pure (no side effects, no Zotero); exported for testability.
 */
export function sampleForTaxonomy(
  items: LibraryItem[],
  limit: number = DEFAULT_SAMPLE_SIZE,
): LibraryItem[] {
  if (items.length <= limit) {
    return items.slice();
  }
  const topKey = (it: LibraryItem): string =>
    it.collectionPaths.length > 0
      ? it.collectionPaths[0].split("/")[0].toLowerCase()
      : "\uffff"; // sort unfiled last
  const indexed = items.map((it, idx) => ({ it, idx }));
  indexed.sort((a, b) => {
    const ta = topKey(a.it);
    const tb = topKey(b.it);
    if (ta !== tb) {
      return ta < tb ? -1 : 1;
    }
    return a.idx - b.idx; // stable within a stratum
  });
  const stride = Math.ceil(indexed.length / limit);
  const out: LibraryItem[] = [];
  for (let i = 0; i < indexed.length && out.length < limit; i += stride) {
    out.push(indexed[i].it);
  }
  return out;
}

/**
 * Propose a taxonomy by sampling the library, building a prompt, calling the
 * LLM, and validating the JSON response with up to `MAX_RETRIES` retries.
 *
 * Throws a descriptive `Error` if the response cannot be validated after all
 * retries (the orchestrator surfaces this to the user via notification).
 */
export async function proposeTaxonomy(
  items: LibraryItem[],
  onDetail?: (detail: string) => void,
  onChunk?: ChunkCallback,
): Promise<TaxonomyNode[]> {
  const sample = sampleForTaxonomy(items, TAXONOMY_SAMPLE_LIMIT);
  const customPrompt = safeGetPref(
    `${config.prefsPrefix}.taxonomySystemPrompt`,
  );
  const { system, user } = buildTaxonomyPrompt(
    sample,
    customPrompt.trim() || undefined,
  );

  onDetail?.(
    `Stage 1: Sending ${sample.length} items to the LLM. ` +
      `Asking for 8–15 top-level areas, max depth 3, with descriptions. ` +
      `Temperature: 0 (deterministic).`,
  );

  let messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    onDetail?.(
      attempt === 0
        ? `Stage 1: Calling LLM (attempt ${attempt + 1}/${MAX_RETRIES + 1})…`
        : `Stage 1: Retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Previous error: ${lastError}`,
    );
    const raw = await chatComplete(messages, { temperature: 0 }, onChunk);
    const extracted = extractJson(raw);
    if (!extracted.ok) {
      lastError = extracted.error;
    } else {
      const validated = validateTaxonomy(extracted.value);
      if (validated.ok) {
        const topAreas = validated.value.map((t) => t.name).join(", ");
        onDetail?.(
          `Stage 1: LLM returned a valid taxonomy with ${validated.value.length} top-level areas: ${topAreas}`,
        );
        return validated.value;
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
    `Taxonomy proposal failed after ${MAX_RETRIES} retries. Last error: ${lastError}`,
  );
}
