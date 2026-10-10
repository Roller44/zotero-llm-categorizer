# Taxonomy Proposal Stage

This document covers **Stage 1** of the two-stage LLM categorization pipeline (Gate 3 of the Smart Organizer plugin): proposing a hierarchical taxonomy from a sample of the user's Zotero library. The work is split across two modules:

- `src/modules/taxonomyStage.ts` — the orchestrator. Samples the library, calls the LLM, validates the JSON response, and retries on failure.
- `src/modules/promptBuilder.ts` — pure prompt builders. Constructs the system + user message pairs fed to the LLM, with no side effects and no Zotero dependencies, so they are unit-testable under plain Node.

Stage 1 performs **no Zotero reads** (the caller hands it a `LibraryItem[]` from Gate 2's `readLibrary()`) and **no writes** of any kind. The `TaxonomyNode[]` it returns is a data object consumed by Stage 2 (the per-item classifier) and ultimately by Gate 4's review UI.

---

## Module: `taxonomyStage.ts`

### Constants

```ts
const DEFAULT_SAMPLE_SIZE = 150;  // taxonomyStage.ts:31
const MAX_RETRIES = 2;             // taxonomyStage.ts:34
```

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_SAMPLE_SIZE` | `150` | Default upper bound on the sample size for `sampleForTaxonomy`. **Not used by `proposeTaxonomy`**, which passes `TAXONOMY_SAMPLE_LIMIT` (40) from `promptBuilder.ts` instead. Kept as a library-default for callers that don't specify a limit. |
| `MAX_RETRIES` | `2` | Maximum retry attempts after a malformed LLM response. Total attempts = `MAX_RETRIES + 1` = 3. |

### sampleForTaxonomy

Take a representative sample of up to `limit` items using a stratified strategy, so all existing top-level collection areas are represented in the prompt rather than just the first N items.

```ts
export function sampleForTaxonomy(
  items: LibraryItem[],
  limit: number = DEFAULT_SAMPLE_SIZE,
): LibraryItem[]   // taxonomyStage.ts:45
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The full library item list (typically from Gate 2's `readLibrary()`). |
| `limit` | `number` | No | Upper bound on the returned sample size. Defaults to `DEFAULT_SAMPLE_SIZE` (150). |

**Returns:** `LibraryItem[]` — a new array of at most `limit` items, chosen by stratified stride-sampling over the input.

**Throws:** None. The function is pure and never throws.

**Algorithm** (`taxonomyStage.ts:49-70`):

1. If `items.length <= limit`, return a shallow copy of everything (in original order) — no sampling needed.
2. Compute a stratification key per item: the first segment of `collectionPaths[0]`, lowercased. Items with no collection path sort last via the sentinel `"\uffff"` (the highest Unicode code point), so unfiled items are still sampled but never dominate a stratum.
3. Stable-sort items by `(topKey, originalIndex)` so items within a stratum keep their input order.
4. Compute a `stride = ceil(N / limit)` and walk the sorted array in `stride`-sized steps, pushing the item at each step into the output until `limit` is reached.

**Design decisions:**

- **Stratified over random sampling** — a uniform random sample of a library dominated by one collection would barely mention the minority areas, producing a skewed taxonomy. Stratifying by current top-level collection guarantees every existing area shows up in the prompt.
- **Sentinel `"\uffff"` for unfiled items** (`taxonomyStage.ts:55`) — sorts them to the end without dropping them. Unfiled items are often the most interesting for reorganization.
- **Stable within a stratum** (`taxonomyStage.ts:62-63`) — preserving original order makes the sample deterministic given the same input, which matters because the LLM call is made at `temperature: 0` for reproducibility.
- **Pure / exported for testability** — the function reads no Zotero globals and is exported so unit tests can drive it directly.

### proposeTaxonomy

End-to-end Stage 1: sample the library, build the prompt, call the LLM, validate the JSON, retry on failure, return the validated taxonomy tree.

```ts
export async function proposeTaxonomy(
  items: LibraryItem[],
  onDetail?: (detail: string) => void,
  onChunk?: ChunkCallback,
): Promise<TaxonomyNode[]>   // taxonomyStage.ts:80
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The full library item list to propose a taxonomy for. |
| `onDetail` | `(detail: string) => void` | No | Progress callback invoked for each human-readable status line; wired to the progress UI by the orchestrator. |
| `onChunk` | `ChunkCallback` | No | Streamed-token callback forwarded into `chatComplete` so tokens render in the UI as they arrive. |

**Returns:** `Promise<TaxonomyNode[]>` — the validated taxonomy tree (8–15 top-level areas, max depth 3) emitted by the LLM.

**Throws:** `Error` if every retry attempt fails to produce a valid taxonomy. The thrown message includes the last validator error (e.g. `Taxonomy proposal failed after 2 retries. Last error: <error>`). The orchestrator catches this and surfaces it as a Zotero notification.

**Step-by-step flow:**

1. **Sample** (`taxonomyStage.ts:85`): `sampleForTaxonomy(items, TAXONOMY_SAMPLE_LIMIT)` — note the limit is `TAXONOMY_SAMPLE_LIMIT` (40, from `promptBuilder.ts:23`), **not** `DEFAULT_SAMPLE_SIZE`. The 40-item cap keeps the prompt inside a typical LLM context window.
2. **Resolve the system prompt** (`taxonomyStage.ts:86-92`): read the user's custom prompt from the preference `${config.prefsPrefix}.taxonomySystemPrompt` via `safeGetPref`. If the trimmed value is empty, pass `undefined` so `buildTaxonomyPrompt` falls back to `DEFAULT_TAXONOMY_SYSTEM_PROMPT`.
3. **Build messages** (`taxonomyStage.ts:89-103`): `buildTaxonomyPrompt(sample, customPrompt)` returns `{system, user}`; seed the conversation with `[{role:"system",...}, {role:"user",...}]`.
4. **Detail notification** (`taxonomyStage.ts:94-98`): emit a human-readable line naming the sample size, the requested shape (8–15 top-level areas, max depth 3, with descriptions), and the temperature.
5. **Retry loop** (`taxonomyStage.ts:106-136`): up to `MAX_RETRIES + 1` total attempts.
6. **Throw on exhaustion** (`taxonomyStage.ts:138-140`): if every attempt fails, throw a descriptive `Error` carrying the last validator error. The orchestrator catches this and surfaces it as a Zotero notification.

**LLM call parameters:** `chatComplete(messages, { temperature: 0 }, onChunk)` (`taxonomyStage.ts:112`). Temperature 0 is set for reproducibility on the OpenAI-compatible path; Anthropic ignores the option, which the module comment (`taxonomyStage.ts:11`) notes as acceptable.

#### The retry mechanism — CRITICAL design note

The retry loop in `taxonomyStage.ts:128-135` is the most important and most subtle part of this module:

```ts
if (attempt < MAX_RETRIES) {
  const retry = buildRetryPrompt(lastError);
  messages = [
    ...messages,
    { role: "assistant", content: raw },
    { role: "user", content: retry.user },
  ];
}
```

**Retries APPEND to the message history, they do not replace it.** Each retry extends `messages` with:

1. The LLM's own previous (invalid) response as an `assistant` message.
2. A new `user` message (built by `buildRetryPrompt`) explaining what was wrong.

This was a **fatal bug in an earlier implementation**: the previous code rebuilt the message list from scratch on each retry, sending only `{system, user, "your last answer was wrong: <error>"}`. Without the LLM's prior output in context, the model had no idea which of the many possible malformed responses it had produced, and would re-emit a fresh (often differently malformed) response. With the bad response appended to history, the LLM can see exactly what it emitted and patch it in place.

A secondary consequence: the conversation grows by two messages per retry, so the loop is bounded at `MAX_RETRIES = 2` to keep prompt size under control. After two retries the function gives up and throws.

#### Validation flow per attempt

For each attempt (`taxonomyStage.ts:112-126`):

1. `chatComplete(messages, { temperature: 0 }, onChunk)` → `raw` string.
2. `extractJson(raw)` — strip markdown fences / leading prose and `JSON.parse`. If it fails, `lastError = extracted.error` and we fall through to the retry branch.
3. If parsing succeeds, `validateTaxonomy(extracted.value)` checks the structural constraints (8–15 top-level areas, max depth 3, unique paths, `path` equals parent-path + "/" + name, etc.). On success, emit a detail line listing the top-level area names and return `validated.value`.
4. If validation fails, `lastError = validated.error` and we retry (subject to `MAX_RETRIES`).

`extractJson` and `validateTaxonomy` both live in `./planValidator`, which is the single source of truth for "what is a valid taxonomy." Stage 1 never re-implements those checks.

#### Progress callbacks

- `onDetail` (`taxonomyStage.ts:82`) — invoked for every status line, e.g. `"Stage 1: Sending 40 items to the LLM..."`, `"Stage 1: Calling LLM (attempt 1/3)…"`, `"Stage 1: Retrying (attempt 2/3). Previous error: <error>"`, `"Stage 1: LLM returned a valid taxonomy with 12 top-level areas: ..."`. The orchestrator wires this to the progress UI.
- `onChunk` (`taxonomyStage.ts:83`, type `ChunkCallback` from `./llmClient`) — forwarded straight into `chatComplete` so streamed tokens can render in the UI as they arrive.

### Module-level design notes

- **Determinism** (`taxonomyStage.ts:10-12`): the module comment explicitly states `temperature: 0` is used for reproducibility, and acknowledges Anthropic ignores the option.
- **No Zotero I/O**: the module imports only types and pure functions from sibling modules plus `chatComplete`/`safeGetPref` from `./llmClient`. It is testable without a Zotero instance.
- **Imports** (`taxonomyStage.ts:14-28`): types from `./libraryModel` and `./categorizationTypes`; `chatComplete`, `safeGetPref`, `ChatMessage`, `ChunkCallback` from `./llmClient`; `buildRetryPrompt`, `buildTaxonomyPrompt`, `TAXONOMY_SAMPLE_LIMIT` from `./promptBuilder`; `extractJson`, `validateTaxonomy` from `./planValidator`; `config` from `../../package.json` for the preference prefix.

---

## Module: `promptBuilder.ts`

A pure, dependency-light module. Per its header comment (`promptBuilder.ts:1-13`), it depends ONLY on the `LibraryItem` type (from `libraryModel.ts`, which has no Zotero globals) and the interface-only `categorizationTypes.ts`. It therefore runs under plain Node with `--experimental-strip-types` and no network, satisfying the Gate 3 work order's "fully unit testable" requirement. Every function is pure and never mutates its inputs.

### Constants

```ts
export const TAXONOMY_SAMPLE_LIMIT = 40;        // promptBuilder.ts:23
const ABSTRACT_BUDGET_CHARS = 0;                // promptBuilder.ts:26
export const TAXONOMY_SCHEMA_INSTRUCTION = ...  // promptBuilder.ts:32
export const CLASSIFICATION_SCHEMA_INSTRUCTION = ...  // promptBuilder.ts:61
export const DEFAULT_TAXONOMY_SYSTEM_PROMPT = ...     // promptBuilder.ts:77
export const DEFAULT_CLASSIFICATION_SYSTEM_PROMPT = ...  // promptBuilder.ts:106
```

| Constant | Value | Purpose |
|---|---|---|
| `TAXONOMY_SAMPLE_LIMIT` | `40` | Max sample items the taxonomy prompt will serialize. `proposeTaxonomy` passes this to `sampleForTaxonomy`. The docstring notes the constant is also used to compute the abstract truncation budget so the prompt fits a typical LLM context window. |
| `ABSTRACT_BUDGET_CHARS` | `0` | Characters of abstract to retain per item. **Currently 0**, meaning abstracts are omitted entirely from the prompt (`serializeItemForPrompt` skips the abstract line when this is 0). The hook is left in place so a future tuning pass can raise it without restructuring the function. |
| `TAXONOMY_SCHEMA_INSTRUCTION` | string | The JSON schema description embedded in the taxonomy prompt. Kept as a constant so tests can assert the prompt references it. |
| `CLASSIFICATION_SCHEMA_INSTRUCTION` | string | Same idea, for Stage 2. Documented here for context; the classification stage is covered in `07-classification-stage.md`. |
| `DEFAULT_TAXONOMY_SYSTEM_PROMPT` | string | Default Stage 1 system prompt; used when no custom prompt is set. See below. |
| `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` | string | Default Stage 2 system prompt. Documented in the classification-stage doc. |

### DEFAULT_TAXONOMY_SYSTEM_PROMPT

Defined at `promptBuilder.ts:77-100` as a joined string array (joined with `\n`). The array form is used so the source stays diff-friendly. The full text instructs the model it is a "research-library taxonomy architect" and lays down the **hard constraints** that define a valid taxonomy:

| Constraint | Where enforced |
|---|---|
| **8 to 15 top-level areas.** | `validateTaxonomy` (in `planValidator`) |
| **Maximum depth 3** (top-level area / child / grandchild). Do NOT go deeper. | `validateTaxonomy` |
| Names must be concise, research-domain-oriented (e.g. `SemanticComm`, `ChannelCoding`, `ResourceAlloc`). No generic names like `Other`. | Soft — prompt only; validator does not police naming style. |
| **Each collection PATH must be unique.** Two collections may share a leaf name only if they have different parent paths (e.g. `Wireless/MACProtocols` and `Wired/MACProtocols` are both fine). | `validateTaxonomy` |
| Avoid reusing an existing top-level collection's name as a leaf name under a different parent — that would create two same-named collections with different papers. Marked as a **hint only**; the authoritative guard lives in the applier (Gate 4). | Applier stage |
| Every paper in the sample must plausibly fit somewhere in the tree. | Soft — prompt only. |
| **Each node's `path` MUST equal its parent's `path` + `/` + its own name**, with the root node's path equal to its name (no leading slash). | `validateTaxonomy` |
| Return STRICT JSON (no markdown fences, no prose) matching the embedded schema. | `extractJson` tolerates fences/prose; `validateTaxonomy` checks shape. |

The schema shape embedded via `TAXONOMY_SCHEMA_INSTRUCTION` (`promptBuilder.ts:32-56`) is:

```json
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
}
```

The leaf grandchild explicitly carries `"children": []`, signalling that depth 3 is a hard floor.

**Why unique paths, not unique names:** the prompt spells out (`promptBuilder.ts:88-90`) that two collections may share a leaf name if their parent paths differ. This matters for real libraries: a `MACProtocols` child is plausible under both `Wireless/` and `Wired/`. Enforcing unique names would force artificial disambiguation (`MACProtocols-Wireless`, `MACProtocols-Wired`); enforcing unique paths lets the taxonomy mirror the domain while still giving each collection an unambiguous locator. The `path` field is what the applier uses to create collections, so path-uniqueness is the load-bearing invariant.

**Why 8–15 top-level areas:** small enough to be browsable in a Zotero collection tree, large enough to avoid a catch-all bucket. Fewer than 8 tends to produce vague categories ("ML", "Comms"); more than 15 produces a flat, hard-to-scan tree.

**Why max depth 3:** deeper taxonomies are hard to navigate in Zotero's left pane and tend to over-fit the sample. Three levels (area / sub-area / topic) is the standard library-science compromise.

### truncate

Module-private helper. Collapses all whitespace runs to single spaces, trims, and if the result exceeds `max` characters, slices to `max - 1` and appends `"…"`.

```ts
function truncate(text: string, max: number): string   // promptBuilder.ts:131
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `text` | `string` | Yes | Input string. `null`/`undefined` is coerced to `""` via `?? ""`. |
| `max` | `number` | Yes | Maximum number of characters to retain in the output. |

**Returns:** `string` — the whitespace-collapsed, trimmed string, truncated to `max` characters with a trailing `"…"` if it was longer.

**Throws:** None. The `?? ""` guard ensures the function never throws, even on `null`/`undefined` input.

Pure, never throws (the `?? ""` guards against `null`/`undefined` input).

### serializeItemForPrompt

Serialize a single `LibraryItem` into the compact, one-line-per-field form used by both Stage 1 and Stage 2 prompts.

```ts
export function serializeItemForPrompt(item: LibraryItem): string   // promptBuilder.ts:143
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item` | `LibraryItem` | Yes | The library item to serialize. Missing string fields become empty strings via `truncate`. |

**Returns:** `string` — a newline-separated block of `key: value` lines describing the item.

**Throws:** None. Pure; never mutates its input and never throws.

**Output shape:**

```
itemId: 12345
title: <up to 200 chars>
venue: <up to 80 chars>
date: <up to 10 chars>
currentTopCollection: <first segment of first collectionPath, or "(unfiled)">
[abstract: <up to ABSTRACT_BUDGET_CHARS chars>]   // only if budget > 0
```

**Field handling:**

- `currentTopCollection` (`promptBuilder.ts:144-147`): the first `/`-delimited segment of `collectionPaths[0]`, or `"(unfiled)"` if the item has no collection paths. This gives the LLM a hint about the library's existing structure without exposing the full path (which would bias it toward the current taxonomy).
- `creators` (`promptBuilder.ts:148-151`): mapped to `"lastName, firstName"` pairs joined by `"; "`. **Computed but not currently emitted** in the output lines — the function builds the string but the `lines` array never includes it. This is either a latent feature or dead code; the prompts work without author names because title + venue + date are usually sufficient for taxonomy proposal. (Left in place; flagged here so a maintainer doesn't assume authors are in the prompt.)
- Title is truncated to 200 chars, venue to 80, date to 10. Abstract is omitted entirely because `ABSTRACT_BUDGET_CHARS = 0`.

### buildTaxonomyPrompt

Build the `{system, user}` message pair for Stage 1.

```ts
export function buildTaxonomyPrompt(
  sample: LibraryItem[],
  customSystemPrompt?: string,
): { system: string; user: string }   // promptBuilder.ts:171
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sample` | `LibraryItem[]` | Yes | The sampled items to serialize into the user prompt. Each is rendered via `serializeItemForPrompt`. |
| `customSystemPrompt` | `string` | No | Optional user-provided system prompt override (read from Zotero preferences by `proposeTaxonomy`). Used verbatim if it trims to a non-empty string; otherwise `DEFAULT_TAXONOMY_SYSTEM_PROMPT` is used. |

**Returns:** `{ system: string; user: string }` — the message pair ready to feed into `chatComplete`. The `system` field is the chosen system prompt; the `user` field contains the serialized sample and the closing "Return ONLY the JSON" instruction.

**Throws:** None. Pure and deterministic; no side effects.

**System prompt selection** (`promptBuilder.ts:178-181`): if `customSystemPrompt` trims to a non-empty string, use it; otherwise fall back to `DEFAULT_TAXONOMY_SYSTEM_PROMPT`. This is the override hook the preferences pane drives — the user can replace the entire system prompt while leaving the user prompt (and the sample) intact.

**User prompt** (`promptBuilder.ts:183-194`):

```
Here are <N> sample papers from a research library
(primarily wireless communications and adjacent ML/SEM topics):

--- paper 1 ---
itemId: ...
title: ...
venue: ...
date: ...
currentTopCollection: ...

--- paper 2 ---
...

Propose the taxonomy. Return ONLY the JSON object described above.
```

The "primarily wireless communications and adjacent ML/SEM topics" framing (`promptBuilder.ts:189`) is a soft domain hint baked into the prompt — it biases the LLM toward comms/ML taxonomy naming conventions (the `SemanticComm` / `ChannelCoding` examples in the default system prompt reinforce this). For a library in a different domain the user would override via `customSystemPrompt`; this user-prompt line is not currently customizable.

Each sample item is rendered with `serializeItemForPrompt`, prefixed by `--- paper <i+1> ---`. Papers are joined with a blank line for readability.

### buildRetryPrompt

Build the corrective retry message appended after the LLM's failed response. `error` is the validator's human-readable error message (from `extractJson` or `validateTaxonomy`).

```ts
export function buildRetryPrompt(error: string): {
  system: string;
  user: string;
}   // promptBuilder.ts:247
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `error` | `string` | Yes | The validator's human-readable error message describing what was wrong with the LLM's previous response. |

**Returns:** `{ system: string; user: string }` — the corrective message pair. **Only the `user` field is used by `proposeTaxonomy`** (`taxonomyStage.ts:131-134`). The `system` field is included for symmetry with the other builders and for direct testability of this function, but the retry loop appends only `{role:"assistant", content: raw}` and `{role:"user", content: retry.user}` to the existing conversation — it does not re-send a system message. Re-sending a system message mid-conversation would be redundant and, on some providers, can confuse instruction-following.

**Throws:** None. Pure and deterministic.

**`user` content** (`promptBuilder.ts:256-263`):

```
Your previous response could not be used:

<error>

Re-emit the FULL corrected JSON object now. Output ONLY the JSON, no prose,
no markdown fences.
```

The phrasing "Re-emit the FULL corrected JSON object" is deliberate: some models, when told "fix the error", emit only the patched fragment. The taxonomy validator needs the entire tree to re-check path-uniqueness and depth, so the retry insists on the full object.

**Why the bad response stays in context** — see the "retry mechanism" note in the `taxonomyStage.ts` section above. `buildRetryPrompt` is intentionally a *follow-up* message builder, not a fresh-conversation builder. It assumes the prior assistant turn is still in `messages`.

### buildClassificationPrompt

Stage 2 builder, documented here for completeness. It mirrors `buildTaxonomyPrompt`'s structure: custom-system-prompt override, items block via `serializeItemForPrompt`, and a closing "Return ONLY the JSON" line.

```ts
export function buildClassificationPrompt(
  batch: LibraryItem[],
  taxonomyPaths: string[],
  customSystemPrompt?: string,
): { system: string; user: string }   // promptBuilder.ts:206
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `batch` | `LibraryItem[]` | Yes | The slice of items to classify in this single LLM call. |
| `taxonomyPaths` | `string[]` | Yes | Flat list of every valid path in the proposed taxonomy (produced by `flattenTaxonomyPaths`). Prepended to the user prompt so the LLM cannot invent paths. |
| `customSystemPrompt` | `string` | No | Optional user-provided system prompt override. Used verbatim if non-empty; otherwise `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` is used. |

**Returns:** `{ system: string; user: string }` — the Stage 2 message pair. The user prompt prepends a `Taxonomy paths (N total):` block listing every valid path, so the LLM cannot invent paths.

**Throws:** None. Pure and deterministic.

Full coverage lives in `07-classification-stage.md`.

---

## Interaction with other modules

```
                 ┌────────────────────────┐
                 │  orchestrator (Gate 3) │
                 └───────────┬────────────┘
                             │ items: LibraryItem[]
                             ▼
                 ┌────────────────────────┐
                 │   proposeTaxonomy()    │  taxonomyStage.ts
                 │   sampleForTaxonomy()  │
                 └───────────┬────────────┘
                             │ sample
                             ▼
                 ┌────────────────────────┐
                 │  buildTaxonomyPrompt() │  promptBuilder.ts
                 │  buildRetryPrompt()    │
                 └───────────┬────────────┘
                             │ {system, user}
                             ▼
                 ┌────────────────────────┐
                 │   chatComplete()       │  llmClient (Gate 1)
                 └───────────┬────────────┘
                             │ raw string
                             ▼
                 ┌────────────────────────┐
                 │  extractJson()         │  planValidator
                 │  validateTaxonomy()    │
                 └───────────┬────────────┘
                             │ TaxonomyNode[]
                             ▼
                 Stage 2 (classification) → Gate 4 (review/applier)
```

- **`libraryModel.ts`** supplies `LibraryItem` — the only type that crosses the boundary into the pure prompt builders.
- **`categorizationTypes.ts`** supplies `TaxonomyNode` — the return type of `proposeTaxonomy` and the input to Stage 2.
- **`llmClient.ts`** (Gate 1) supplies `chatComplete`, `safeGetPref`, `ChatMessage`, `ChunkCallback`.
- **`planValidator.ts`** supplies `extractJson` and `validateTaxonomy` — the single source of truth for "what is a valid taxonomy." Stage 1 never re-implements those checks.
- **Stage 2 / Gate 4** consume the returned `TaxonomyNode[]` to classify each item and apply the result.

---

## How to extend

### Change the sample size

Bump `TAXONOMY_SAMPLE_LIMIT` in `promptBuilder.ts:23`. The constant is the single knob `proposeTaxonomy` uses (`taxonomyStage.ts:85`). Raising it increases prompt size linearly; the abstract-truncation budget hook (`ABSTRACT_BUDGET_CHARS`) exists precisely so you can re-enable abstracts once the sample is small enough to leave room.

### Override the system prompt

Set the Zotero preference `${config.prefsPrefix}.taxonomySystemPrompt`. `proposeTaxonomy` reads it via `safeGetPref` (`taxonomyStage.ts:86-88`) and passes it to `buildTaxonomyPrompt`, which uses it verbatim if non-empty (`promptBuilder.ts:178-181`). The default is exposed as `DEFAULT_TAXONOMY_SYSTEM_PROMPT` so the preferences pane can populate its textarea with the default when the user has not set a custom one (`promptBuilder.ts:73-76`).

### Change the retry budget

Bump `MAX_RETRIES` in `taxonomyStage.ts:34`. Note the conversation grows by two messages per retry (the bad assistant turn plus the corrective user turn), so very high values will balloon prompt size and cost. The current value of 2 (3 total attempts) was chosen to balance recovery against cost.

### Add a new field to the per-item serialization

Edit `serializeItemForPrompt` in `promptBuilder.ts:143`. Both Stage 1 and Stage 2 use this function, so the change propagates to both prompts. If the new field is large, also raise `ABSTRACT_BUDGET_CHARS` or add a parallel budget constant to keep total prompt size under control.

### Tighten or relax the taxonomy constraints

The constraints are enforced in two places: the **prompt text** (`DEFAULT_TAXONOMY_SYSTEM_PROMPT`) and the **validator** (`validateTaxonomy` in `planValidator.ts`). Changing only the prompt is a soft nudge; the validator is the hard floor. To change a hard constraint (e.g. allow depth 4), edit both — otherwise the validator will reject LLM responses that obeyed the new prompt.

### Replace the LLM client

`proposeTaxonomy` calls `chatComplete` from `./llmClient`. Any replacement that honors the `ChatMessage[]` / `{ temperature }` / `ChunkCallback` contract can be substituted there without touching this module.
