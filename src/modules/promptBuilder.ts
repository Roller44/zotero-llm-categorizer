/**
 * Pure prompt builders for the two-stage LLM categorization pipeline.
 *
 * This module depends ONLY on the dependency-free `LibraryItem` type (from
 * `libraryModel.ts`, which has no Zotero globals / no relative imports) and
 * the interface-only `categorizationTypes.ts`. It therefore runs under plain
 * Node with `--experimental-strip-types` and no network — making it fully unit
 * testable, as required by the Gate 3 work order.
 *
 * The functions return `{system, user}` message pairs ready to feed into
 * `chatComplete()` from Gate 1's client. They build deterministic, schema-rich
 * prompts and never mutate their inputs.
 */

import type { LibraryItem } from "./libraryModel";

/**
 * Maximum number of sample items the taxonomy prompt will serialize. The
 * orchestrator is responsible for sampling down to this many; this constant is
 * only used to compute the abstract truncation budget so the prompt fits a
 * typical LLM context window.
 */
export const TAXONOMY_SAMPLE_LIMIT = 40;

/** Characters of abstract to retain per item in the taxonomy prompt. */
const ABSTRACT_BUDGET_CHARS = 0;

/**
 * The JSON schema description embedded in the taxonomy prompt. Kept as a
 * constant string so tests can assert that the prompt references it.
 */
export const TAXONOMY_SCHEMA_INSTRUCTION = `Return STRICT JSON (no markdown fences, no prose) matching this shape:
{
  "taxonomy": [
    {
      "name": "<top-level area, concise>",
      "path": "<top-level area name, identical to name>",
      "description": "<one sentence: what belongs here>",
      "children": [
        {
          "name": "<child area>",
          "path": "<parent>/<child>",
          "description": "<one sentence>",
          "children": [
            {
              "name": "<grandchild area>",
              "path": "<parent>/<child>/<grandchild>",
              "description": "<one sentence>",
              "children": []
            }
          ]
        }
      ]
    }
  ]
}`;

/**
 * The JSON schema description embedded in the classification prompt.
 */
export const CLASSIFICATION_SCHEMA_INSTRUCTION = `Return STRICT JSON (no markdown fences, no prose) matching this shape:
{
  "assignments": [
    {
      "itemId": <number, must match an id from the batch>,
      "collectionPaths": ["<path from the taxonomy, 1 to 3 paths>"],
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

/**
 * The default system prompt for Stage 1 (taxonomy proposal). Extracted as a
 * constant so the preferences pane can populate its textarea with the default
 * when the user has not set a custom one. Pure string — no dependencies.
 */
export const DEFAULT_TAXONOMY_SYSTEM_PROMPT = [
  "You are a research-library taxonomy architect.",
  "Given a sample of academic papers (title, venue, date, and current",
  "top-level collection), propose a hierarchical taxonomy that",
  "the FULL library could be reorganized into.",
  "",
  "Hard constraints:",
  "- 8 to 15 top-level areas.",
  "- Maximum depth 3 (top-level area / child / grandchild). Do NOT go deeper.",
  "- Names must be concise, research-domain-oriented (e.g. 'SemanticComm',",
  "  'ChannelCoding', 'ResourceAlloc'). No generic names like 'Other'.",
  "- Each collection PATH must be unique. Two collections may share a leaf",
  "  name only if they have different parent paths (e.g.",
  "  'Wireless/MACProtocols' and 'Wired/MACProtocols' are both fine).",
  "- The existing library may already contain collections whose names you do",
  "  not see here. Where possible, avoid reusing an existing top-level",
  "  collection's name as a leaf name under a different parent — that would",
  "  create two same-named collections with different papers. (Hint only; the",
  "  authoritative guard lives in the applier.)",
  "- Every paper in the sample must plausibly fit somewhere in the tree.",
  "- Each node's `path` MUST equal its parent's path + '/' + its own name,",
  "  with the root node's path equal to its name (no leading slash).",
  "- " + TAXONOMY_SCHEMA_INSTRUCTION,
].join("\n");

/**
 * The default system prompt for Stage 2 (per-item classification). Extracted
 * as a constant for the same reason as `DEFAULT_TAXONOMY_SYSTEM_PROMPT`.
 */
export const DEFAULT_CLASSIFICATION_SYSTEM_PROMPT = [
  "You are a research-library classifier.",
  "You are given a fixed taxonomy (as a list of slash-delimited collection",
  "paths) and a batch of papers. Assign each paper to between 1 and 3 paths",
  "from the taxonomy. Use the most specific path that fits. If a paper does",
  "not clearly fit any path, assign it to the closest top-level area and set",
  "confidence to 'low'.",
  "",
  "Hard constraints:",
  "- Every path in `collectionPaths` MUST appear verbatim in the provided",
  "  taxonomy path list. Do not invent new paths.",
  "- Use the FULL slash-delimited path (e.g. 'SemanticComm/JSCC/Analog'),",
  "  NOT just the leaf name. Two collections may share a leaf name but have",
  "  different parent paths — always use the complete path.",
  "- Return one assignment object per item in the batch, with the matching",
  "  `itemId`.",
  "- Set `confidence` to 'high' only when the paper clearly belongs; 'medium'",
  "  for reasonable but less certain; 'low' for guesses or no fit.",
  "- " + CLASSIFICATION_SCHEMA_INSTRUCTION,
].join("\n");

/**
 * Truncate a string to `max` characters, appending an ellipsis when truncated.
 * Pure. Never throws.
 */
function truncate(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) {
    return t;
  }
  return t.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Serialize a single item to the compact one-line-per-field form used in both
 * prompts. Pure. Missing fields become empty strings.
 */
export function serializeItemForPrompt(item: LibraryItem): string {
  const topCollection =
    item.collectionPaths.length > 0
      ? item.collectionPaths[0].split("/")[0]
      : "(unfiled)";
  const creators = item.creators
    .map((c) => [c.lastName, c.firstName].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
  const lines = [
    `itemId: ${item.id}`,
    `title: ${truncate(item.title, 200)}`,
    `venue: ${truncate(item.publicationTitle, 80)}`,
    `date: ${truncate(item.date, 10)}`,
    `currentTopCollection: ${topCollection}`,
  ];
  if (ABSTRACT_BUDGET_CHARS > 0) {
    lines.push(`abstract: ${truncate(item.abstract, ABSTRACT_BUDGET_CHARS)}`);
  }
  return lines.join("\n");
}

/**
 * Build the system + user messages for Stage 1 (taxonomy proposal).
 *
 * The user message includes every sample item's serialized form and the
 * schema instruction. Pure, deterministic, no side effects.
 */
export function buildTaxonomyPrompt(
  sample: LibraryItem[],
  customSystemPrompt?: string,
): {
  system: string;
  user: string;
} {
  const system =
    customSystemPrompt && customSystemPrompt.trim().length > 0
      ? customSystemPrompt
      : DEFAULT_TAXONOMY_SYSTEM_PROMPT;

  const itemsBlock = sample
    .map((it, i) => `--- paper ${i + 1} ---\n${serializeItemForPrompt(it)}`)
    .join("\n\n");

  const user = [
    `Here are ${sample.length} sample papers from a research library`,
    "(primarily wireless communications and adjacent ML/SEM topics):",
    "",
    itemsBlock,
    "",
    "Propose the taxonomy. Return ONLY the JSON object described above.",
  ].join("\n");

  return { system, user };
}

/**
 * Build the system + user messages for Stage 2 (per-item classification).
 *
 * `taxonomyPaths` is the flat list of every valid path in the proposed
 * taxonomy (produced by `flattenTaxonomyPaths`). The batch is the slice of
 * items to classify in this single LLM call. Pure, deterministic.
 */
export function buildClassificationPrompt(
  batch: LibraryItem[],
  taxonomyPaths: string[],
  customSystemPrompt?: string,
): { system: string; user: string } {
  const system =
    customSystemPrompt && customSystemPrompt.trim().length > 0
      ? customSystemPrompt
      : DEFAULT_CLASSIFICATION_SYSTEM_PROMPT;

  const taxonomyBlock = [
    `Taxonomy paths (${taxonomyPaths.length} total):`,
    taxonomyPaths.map((p) => `- ${p}`).join("\n"),
  ].join("\n");

  const itemsBlock = batch
    .map((it, i) => `--- paper ${i + 1} ---\n${serializeItemForPrompt(it)}`)
    .join("\n\n");

  const user = [
    taxonomyBlock,
    "",
    `Classify these ${batch.length} papers:`,
    "",
    itemsBlock,
    "",
    "Return ONLY the JSON object described above.",
  ].join("\n");

  return { system, user };
}

/**
 * Build the corrective retry message appended after the LLM's failed response.
 * `error` is the validator's human-readable error message.
 *
 * The retry is sent as a follow-up user message in the SAME conversation, so
 * the LLM retains the original system prompt, the item sample, and its own
 * previous (invalid) output. This lets it fix the JSON in context rather than
 * guessing from a bare error string. Pure.
 */
export function buildRetryPrompt(error: string): {
  system: string;
  user: string;
} {
  const system = [
    "Your previous response could not be parsed or did not match the required",
    "JSON schema. Return ONLY the corrected JSON object, with no markdown",
    "fences and no prose.",
  ].join("\n");
  const user = [
    "Your previous response could not be used:",
    "",
    error,
    "",
    "Re-emit the FULL corrected JSON object now. Output ONLY the JSON, no prose,",
    "no markdown fences.",
  ].join("\n");
  return { system, user };
}
