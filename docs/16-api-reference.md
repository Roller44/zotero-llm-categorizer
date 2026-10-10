# API Reference

Flat, structured reference for every exported function, type, interface, and constant in the Zotero Smart Organizer plugin. Organized by module for quick lookup. Each entry lists the full TypeScript signature, a parameter table, return type, thrown exceptions, and a one-line description.

> Conventions: `path:line` references cite the source location. "Pure" means no Zotero globals, no network, no I/O — unit-testable under plain Node with `--experimental-strip-types`.

---

## Module: categorizationTypes

Interface-only module — no runtime logic, no relative imports. Shared by the pure validators (`promptBuilder.ts`, `planValidator.ts`) and the orchestration modules that touch Zotero / the LLM (`taxonomyStage.ts`, `classificationStage.ts`, `categorizer.ts`). Source: `src/modules/categorizationTypes.ts`.

### Types

```typescript
export interface TaxonomyNode {
  name: string;
  path: string;
  children: TaxonomyNode[];
  description: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Human-readable collection name, e.g. `"SemanticComm"`. |
| `path` | `string` | Full slash-delimited path from root, e.g. `"SemanticComm/JSCC/Analog"`. Unique key. |
| `children` | `TaxonomyNode[]` | Child nodes; empty for leaf collections. |
| `description` | `string` | One-sentence description of what belongs here (LLM-provided). |

```typescript
export interface ItemAssignment {
  itemId: number;
  title: string;
  collectionPaths: string[];
  confidence: "high" | "medium" | "low";
}
```

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | The `LibraryItem.id` this assignment is for. |
| `title` | `string` | Item title (review UI only; not used for logic). |
| `collectionPaths` | `string[]` | Proposed collection paths; an item may belong to multiple. |
| `confidence` | `"high" \| "medium" \| "low"` | Heuristic confidence derived from the LLM's stated confidence and whether any paths survived validation. |

```typescript
export interface CategorizationPlan {
  taxonomy: TaxonomyNode[];
  assignments: ItemAssignment[];
  stats: {
    totalItems: number;
    itemsWithAssignment: number;
    itemsUnfiled: number;
    totalCollections: number;
    topLevelCollections: number;
  };
  model: string;
  generatedAt: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Proposed taxonomy tree (root nodes). |
| `assignments` | `ItemAssignment[]` | Per-item assignments; length = number of items read. |
| `stats` | `object` | Summary stats for the review UI (see fields below). |
| `stats.totalItems` | `number` | Total items read. |
| `stats.itemsWithAssignment` | `number` | Items with at least one valid path. |
| `stats.itemsUnfiled` | `number` | Items with no valid path. |
| `stats.totalCollections` | `number` | Total collections in the proposed taxonomy. |
| `stats.topLevelCollections` | `number` | Top-level (root) collections. |
| `model` | `string` | LLM model used (for reproducibility). |
| `generatedAt` | `string` | ISO timestamp of plan generation. |

---

## Module: categorizer

Orchestrator for the two-stage pipeline (Gate 3). Reads the library (read-only), proposes a taxonomy, classifies every item, returns a `CategorizationPlan`. Performs NO writes. Source: `src/modules/categorizer.ts`.

### Functions

```typescript
export async function generatePlan(
  onProgress?: (update: ProgressUpdate) => void,
): Promise<CategorizationPlan>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `onProgress` | `(update: ProgressUpdate) => void` | optional | Synchronous progress callback for milestones. |

- **Returns**: `Promise<CategorizationPlan>` — the full reviewable plan.
- **Throws**: Propagates errors from `readLibrary()`, `proposeTaxonomy()`, or `classifyItems()` (e.g. LLM failures, taxonomy validation exhausted retries).
- **Description**: Run the full two-stage pipeline against the live library; reads only, writes nothing. Coalesces reasoning chunks at most every 80ms (`REASONING_FLUSH_MS`) so a fast LLM stream can't saturate the UI (`categorizer.ts:80-100`).

```typescript
export function computeStats(
  totalItems: number,
  taxonomy: TaxonomyNode[],
  assignments: ItemAssignment[],
): CategorizationPlan["stats"]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `totalItems` | `number` | yes | Total items read. |
| `taxonomy` | `TaxonomyNode[]` | yes | Proposed taxonomy tree. |
| `assignments` | `ItemAssignment[]` | yes | Per-item assignments. |

- **Returns**: `CategorizationPlan["stats"]` — the stats block.
- **Throws**: Nothing (pure).
- **Description**: Compute the summary stats block of a `CategorizationPlan`. Pure.

```typescript
export function generatePlanSummary(plan: CategorizationPlan): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | `CategorizationPlan` | yes | The plan to render. |

- **Returns**: `string` — human-readable summary (header, indented taxonomy tree, top 5 paths by item count).
- **Throws**: Nothing.
- **Description**: Render a plan as a human-readable string for the debug log.

### Types

```typescript
export interface ProgressUpdate {
  stage: "reading" | "taxonomy" | "classifying" | "done" | "reasoning";
  message: string;
  detail?: string;
  current?: number;
  total?: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stage` | `"reading" \| "taxonomy" \| "classifying" \| "done" \| "reasoning"` | Pipeline stage. |
| `message` | `string` | Short status line. |
| `detail` | `string?` | Longer detail for the log panel. |
| `current` | `number?` | Current batch index (for `classifying`). |
| `total` | `number?` | Total batches (for `classifying`). |

### Re-exports

`export { sampleForTaxonomy }` — re-exported from `taxonomyStage.ts` (`categorizer.ts:258`).

---

## Module: libraryReader

Read-only library reader. Loads every regular, non-trashed, non-attachment, non-note item into `LibraryItem[]`. Source: `src/modules/libraryReader.ts`.

### Functions

```typescript
export async function readLibrary(): Promise<LibraryItem[]>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `Promise<LibraryItem[]>` — items with metadata and resolved collection paths.
- **Throws**: Propagates `Zotero.Items.getAll(1)` errors. Individual stale collection memberships are caught and skipped (`libraryReader.ts:118-126`), so a single unloaded collection cannot abort the read.
- **Description**: Read all regular, non-trashed items from the user library (libraryID `1`) and map them to the `LibraryItem` model. Missing metadata fields become `""`; an item in no collections has `collectionPaths: []`.

### Re-exports

```typescript
export type { LibraryItem, LibrarySummary };
export { serializeLibrary, summarizeLibrary };
```

These come from `libraryModel.ts` (see below).

---

## Module: libraryModel

Pure, dependency-free data model + serialization. No Zotero globals, no relative imports — unit-testable under plain Node. Source: `src/modules/libraryModel.ts`.

### Types

```typescript
export interface LibraryItem {
  id: number;
  key: string;
  itemType: string;
  title: string;
  abstract: string;
  date: string;
  doi: string;
  publicationTitle: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  tags: string[];
  attachmentCount: number;
  collectionPaths: string[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | `itemID`. |
| `key` | `string` | 8-char Zotero key. |
| `itemType` | `string` | e.g. `"journalArticle"`, `"preprint"`, `"book"`. |
| `title` | `string` | `getField("title")`. |
| `abstract` | `string` | `getField("abstractNote")`. |
| `date` | `string` | Raw date string. |
| `doi` | `string` | `getField("DOI")`. |
| `publicationTitle` | `string` | `getField("publicationTitle")`. |
| `creators` | `{firstName, lastName, creatorType}[]` | Creators (empty strings for missing fields). |
| `tags` | `string[]` | Tag strings only. |
| `attachmentCount` | `number` | `item.getAttachments().length`. |
| `collectionPaths` | `string[]` | e.g. `["SemanticComm/JSCC/Analog", "PureML/LLM"]`. |

```typescript
export interface LibrarySummary {
  total: number;
  withAbstract: number;
  withDoi: number;
  withTag: number;
  withAttachment: number;
  unfiled: number;
  topCollectionPaths: { path: string; count: number }[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `total` | `number` | Total items. |
| `withAbstract` | `number` | Items with a non-empty abstract. |
| `withDoi` | `number` | Items with a DOI. |
| `withTag` | `number` | Items with at least one tag. |
| `withAttachment` | `number` | Items with at least one attachment. |
| `unfiled` | `number` | Items in no collections. |
| `topCollectionPaths` | `{path, count}[]` | Top 5 collection paths by item count, sorted by count desc then path asc. |

### Functions

```typescript
export function serializeLibrary(items: LibraryItem[]): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `LibraryItem[]` | yes | Items to serialize. |

- **Returns**: `string` — stable JSON (object keys sorted alphabetically, recursively; arrays preserved).
- **Throws**: Nothing.
- **Description**: Produce a stable JSON serialization of the item array (does NOT write to disk).

```typescript
export function summarizeLibrary(items: LibraryItem[]): LibrarySummary
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `LibraryItem[]` | yes | Items to summarize. |

- **Returns**: `LibrarySummary` — counts and top 5 paths.
- **Throws**: Nothing (pure).
- **Description**: Compute summary statistics from a `LibraryItem[]`. Pure.

---

## Module: collectionTree

Pure helper for building full slash-delimited collection paths. No Zotero globals, no config imports. Source: `src/modules/collectionTree.ts`.

### Types

```typescript
export interface CollectionNode {
  id: number;
  name: string;
  parentID: number | false;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Collection ID. |
| `name` | `string` | Collection name. |
| `parentID` | `number \| false` | Parent ID; `false` (or `0`) for top-level. |

### Functions

```typescript
export function buildCollectionPath(
  collectionID: number,
  lookup: (id: number) => CollectionNode | undefined,
): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `collectionID` | `number` | yes | The collection whose path to build. |
| `lookup` | `(id: number) => CollectionNode \| undefined` | yes | Resolves a collection ID to a `CollectionNode`. |

- **Returns**: `string` — slash-delimited path in root→leaf order, or `""` if `lookup(collectionID)` is undefined (stale membership).
- **Throws**: `Error("Collection path cycle detected at collectionID <id>")` — defensive against corrupted parent graphs (`collectionTree.ts:43-47`).
- **Description**: Build the full path for a collection by walking `parentID` up to the root.

---

## Module: llmClient

LLM HTTP client. Two providers (openai-compatible / anthropic), selected by `provider` pref. Uses `fetch()` (not `Zotero.HTTP.request`) because reasoning models hold the connection open while "thinking" — XHR would interpret that silence as a timeout (`llmClient.ts:13-19`). Source: `src/modules/llmClient.ts`.

### Functions

```typescript
export function getSettings(): LlmSettings
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `LlmSettings` — endpoint, apiKey, model, provider, maxTokens (default `16384`), timeoutSeconds (default `300`), reasoningEffort (default `"none"`).
- **Throws**: Nothing — every `Zotero.Prefs.get` is wrapped in try/catch (`llmClient.ts:67-73`).
- **Description**: Read LLM settings from Zotero preferences.

```typescript
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options?: ChatOptions,
): PreparedRequest
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `ChatMessage[]` | yes | Conversation messages. |
| `settings` | `LlmSettings` | yes | LLM settings. |
| `options` | `ChatOptions` | optional | Per-call overrides (temperature, max_tokens, reasoning_effort). |

- **Returns**: `PreparedRequest` — URL, headers, JSON body, resolved provider.
- **Throws**: `Error("LLM endpoint URL is not configured.")` / `Error("LLM model is not configured.")` (from `buildRequestPure`).
- **Description**: Re-exported pure `buildRequestPure` — build a request without making any network call.

```typescript
export async function chatComplete(
  messages: ChatMessage[],
  options?: ChatOptions,
  onChunk?: ChunkCallback,
): Promise<string>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `ChatMessage[]` | yes | Conversation messages. |
| `options` | `ChatOptions` | optional | Per-call overrides. |
| `onChunk` | `ChunkCallback` | optional | Per-chunk callback for SSE streams. |

- **Returns**: `Promise<string>` — assistant message text.
- **Throws**: `Error("fetch() is not available in this environment.")`; `Error("LLM request failed (network error): ...")`; `Error("LLM endpoint returned HTTP <status>: ...")`; `Error("LLM streaming response was empty.")`. Also propagates `parseResponse` errors for non-streaming responses.
- **Description**: Send a chat completion request and return the assistant text. Streaming SSE is detected by `content-type` (`text/event-stream` or `octet-stream`); reasoning models that put their answer in `reasoning_content` (e.g. Kimi-K3) are handled by falling back to the reasoning text when content is empty (`llmClient.ts:259-263, 348-351`).

```typescript
export async function testConnection(): Promise<{ ok: boolean; message: string }>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `Promise<{ok: boolean; message: string}>` — `ok=true` with reply preview, or `ok=false` with error message.
- **Throws**: Nothing — catches all errors and returns `ok: false`.
- **Description**: Send a trivial ping (`"ping"`, `max_tokens: 16`) to verify connectivity. Used by the settings "Test connection" button.

### Types

```typescript
export type ChunkCallback = (kind: "content" | "reasoning", text: string) => void;
```

`kind` is `"content"` for normal assistant text or `"reasoning"` for a reasoning-model thinking trace. `text` is the delta for this chunk only.

Re-exported from `llmRequest.ts`: `ChatMessage`, `ChatOptions`, `LlmSettings`, `PreparedRequest`, `Provider`, `ChatRole`.

### Constants

```typescript
export { ANTHROPIC_API_VERSION }; // "2023-06-01"
```

The Anthropic API version header value. Re-exported from `llmRequest.ts` (`llmClient.ts:389`).

### Re-exports

`export { buildRequestPure, normalizeProvider, parseResponse, resolveProvider };` and `export { safeGetPref };` (the latter is the safe pref reader used by `taxonomyStage` / `classificationStage`).

---

## Module: llmRequest

Pure, dependency-free request/response building for the LLM client. No Zotero globals, no config imports. Source: `src/modules/llmRequest.ts`.

### Types

```typescript
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
}

export type Provider = "auto" | "openai" | "anthropic";

export interface LlmSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: Provider;
  maxTokens: number;
  timeoutSeconds: number;
  reasoningEffort: string;
}

export interface PreparedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  provider: "openai" | "anthropic";
}
```

| Interface | Field | Type | Description |
|-----------|-------|------|-------------|
| `ChatMessage` | `role` | `ChatRole` | Sender role. |
| `ChatMessage` | `content` | `string` | Message text. |
| `ChatOptions` | `temperature` | `number?` | Sampling temperature. |
| `ChatOptions` | `max_tokens` | `number?` | Max output tokens. |
| `ChatOptions` | `reasoning_effort` | `string?` | OpenAI o-series reasoning effort. |
| `LlmSettings` | `endpoint` | `string` | Full or base endpoint URL. |
| `LlmSettings` | `apiKey` | `string` | API key. |
| `LlmSettings` | `model` | `string` | Model name. |
| `LlmSettings` | `provider` | `Provider` | `auto` resolves by endpoint hostname. |
| `LlmSettings` | `maxTokens` | `number` | Default max output tokens. |
| `LlmSettings` | `timeoutSeconds` | `number` | Request timeout (seconds). |
| `LlmSettings` | `reasoningEffort` | `string` | `"none"` omits the parameter. |
| `PreparedRequest` | `url` | `string` | Normalized request URL. |
| `PreparedRequest` | `method` | `"POST"` | Always POST. |
| `PreparedRequest` | `headers` | `Record<string, string>` | Auth + content-type headers. |
| `PreparedRequest` | `body` | `string` | JSON body string. |
| `PreparedRequest` | `provider` | `"openai" \| "anthropic"` | Resolved provider. |

### Constants

```typescript
export const ANTHROPIC_API_VERSION = "2023-06-01";
```

The Anthropic API version sent as the `anthropic-version` header. Pinned to the stable Messages API version.

### Functions

```typescript
export function normalizeProvider(value: string): Provider
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `value` | `string` | yes | Raw pref value. |

- **Returns**: `Provider` — `"openai"`, `"anthropic"`, or `"auto"` (for anything else).
- **Throws**: Nothing.
- **Description**: Coerce a pref string to a valid `Provider`.

```typescript
export function resolveProvider(
  provider: Provider,
  endpoint: string,
): "openai" | "anthropic"
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `Provider` | yes | Configured provider. |
| `endpoint` | `string` | yes | Endpoint URL. |

- **Returns**: `"openai" | "anthropic"`. `auto` resolves to `anthropic` if `endpoint` contains `anthropic.com`, else `openai`.
- **Throws**: Nothing.
- **Description**: Resolve the effective provider, applying the `auto` rule.

```typescript
export function normalizeEndpoint(
  endpoint: string,
  provider: "openai" | "anthropic",
): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `endpoint` | `string` | yes | User-entered endpoint (base or full URL). |
| `provider` | `"openai" \| "anthropic"` | yes | Resolved provider. |

- **Returns**: `string` — full chat-completions / messages URL.
- **Throws**: Nothing.
- **Description**: Append the correct path (`/v1/chat/completions` or `/v1/messages`) when the endpoint is a base URL, so both base and full URLs work.

```typescript
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options?: ChatOptions,
): PreparedRequest
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `ChatMessage[]` | yes | Conversation messages. |
| `settings` | `LlmSettings` | yes | LLM settings. |
| `options` | `ChatOptions` | optional | Per-call overrides (default `{}`). |

- **Returns**: `PreparedRequest` — URL, headers, JSON body, resolved provider.
- **Throws**: `Error("LLM endpoint URL is not configured.")` if `settings.endpoint` is empty; `Error("LLM model is not configured.")` if `settings.model` is empty.
- **Description**: Build the request object WITHOUT a network call. The OpenAI body sets `stream: true`; Anthropic omits it (uses non-streaming parse path). `reasoning_effort` is added only when `settings.reasoningEffort` is set and not `"none"`.

```typescript
export function parseResponse(
  provider: "openai" | "anthropic",
  responseText: string,
): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `"openai" \| "anthropic"` | yes | Resolved provider. |
| `responseText` | `string` | yes | Raw response body. |

- **Returns**: `string` — assistant message text (empty string if absent).
- **Throws**: `Error("LLM response was not valid JSON: ...")`; `Error("Anthropic response had no content array.")`; `Error("OpenAI response had no choices array.")`.
- **Description**: Extract the assistant text from a non-streaming provider response body.

---

## Module: taxonomyStage

Stage 1 of the pipeline: propose a hierarchical taxonomy from a sample. Calls the LLM via `chatComplete()` with `temperature: 0`. Source: `src/modules/taxonomyStage.ts`.

### Constants

```typescript
const DEFAULT_SAMPLE_SIZE = 150;
const MAX_RETRIES = 2;
```

`DEFAULT_SAMPLE_SIZE` is the fallback sample size; the actual call uses `TAXONOMY_SAMPLE_LIMIT` (40) from `promptBuilder.ts`. `MAX_RETRIES` is the retry cap after malformed LLM responses (so up to 3 attempts total).

### Functions

```typescript
export function sampleForTaxonomy(
  items: LibraryItem[],
  limit: number = DEFAULT_SAMPLE_SIZE,
): LibraryItem[]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `LibraryItem[]` | yes | Full library. |
| `limit` | `number` | optional | Max sample size (default `150`). |

- **Returns**: `LibraryItem[]` — stratified sample (or all items if `items.length <= limit`).
- **Throws**: Nothing (pure).
- **Description**: Take a representative sample by sorting on the first top-level current collection (unfiled last) and taking every Nth item, so all existing areas are represented.

```typescript
export async function proposeTaxonomy(
  items: LibraryItem[],
  onDetail?: (detail: string) => void,
  onChunk?: ChunkCallback,
): Promise<TaxonomyNode[]>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `LibraryItem[]` | yes | Full library (sampled internally). |
| `onDetail` | `(detail: string) => void` | optional | Progress detail callback. |
| `onChunk` | `ChunkCallback` | optional | LLM stream chunk callback. |

- **Returns**: `Promise<TaxonomyNode[]>` — validated taxonomy root nodes.
- **Throws**: `Error("Taxonomy proposal failed after 2 retries. Last error: <error>")`.
- **Description**: Sample the library, build a prompt, call the LLM, and validate the JSON response with up to `MAX_RETRIES` retries. On failure, appends a corrective retry message (`buildRetryPrompt`) to the same conversation so the LLM can fix the JSON in context.

---

## Module: classificationStage

Stage 2: classify each item into the taxonomy. Batches items (default 10) and runs batches concurrently (default 5) to stay under rate limits. Source: `src/modules/classificationStage.ts`.

### Constants

```typescript
export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_CONCURRENCY = 5;
const MAX_RETRIES = 2;
```

`DEFAULT_BATCH_SIZE` items per LLM call. `DEFAULT_CONCURRENCY` concurrent batches. `MAX_RETRIES` retries per batch.

### Functions

```typescript
export function batchItems<T>(items: T[], size: number): T[][]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `T[]` | yes | Items to batch. |
| `size` | `number` | yes | Batch size (must be > 0). |

- **Returns**: `T[][]` — consecutive batches.
- **Throws**: `Error("batch size must be > 0, got <size>")`.
- **Description**: Split items into consecutive batches. Pure, exported for testability.

```typescript
export async function classifyItems(
  items: LibraryItem[],
  taxonomy: TaxonomyNode[],
  options?: {
    batchSize?: number;
    concurrency?: number;
    onBatchDone?: (completed: number, total: number, detail: string) => void;
    onChunk?: ChunkCallback;
  },
): Promise<ItemAssignment[]>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | `LibraryItem[]` | yes | Items to classify. |
| `taxonomy` | `TaxonomyNode[]` | yes | Proposed taxonomy. |
| `options.batchSize` | `number` | optional | Default `DEFAULT_BATCH_SIZE`. |
| `options.concurrency` | `number` | optional | Default `DEFAULT_CONCURRENCY`. |
| `options.onBatchDone` | `(completed, total, detail) => void` | optional | Per-batch progress callback. |
| `options.onChunk` | `ChunkCallback` | optional | LLM stream chunk callback. |

- **Returns**: `Promise<ItemAssignment[]>` — assignments in input order.
- **Throws**: Propagates `Error("Classification batch failed after 2 retries. Last error: <error>")` from a failed batch (rejects the whole call). Invalid assignment paths are NOT thrown — they are dropped and logged via `Zotero.debug` (`classificationStage.ts:222-233`).
- **Description**: Classify every item against the taxonomy. Invalid paths are dropped; an item ending with zero valid paths is returned with `confidence: "low"` and `collectionPaths: []`. Concurrency is implemented with a simple semaphore that yields to the UI macrotask queue between batch completions (`classificationStage.ts:86-90`).

---

## Module: planValidator

Pure validators for LLM-produced JSON. Strict about structure, lenient about extras (unknown keys ignored). Never throw — return a discriminated `ValidationResult`. Source: `src/modules/planValidator.ts`.

### Types

```typescript
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

### Constants

```typescript
export const MAX_TAXONOMY_DEPTH = 3;
```

Maximum allowed depth of the taxonomy tree (root / child / grandchild). Enforced in `validateNode` (`planValidator.ts:168-173`).

### Functions

```typescript
export function extractJson(text: string): ValidationResult<unknown>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | yes | LLM text response. |

- **Returns**: `ValidationResult<unknown>` — `{ok: true, value}` or `{ok: false, error}`.
- **Throws**: Nothing (never throws; uses try/catch internally).
- **Description**: Extract a JSON value from an LLM response that may be wrapped in markdown fences or surrounded by prose. Strategy: (1) direct `JSON.parse`; (2) fenced ```json``` block; (3) first balanced `{...}` or `[...]` substring.

```typescript
export function validateTaxonomy(json: unknown): ValidationResult<TaxonomyNode[]>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `json` | `unknown` | yes | Parsed JSON payload. |

- **Returns**: `ValidationResult<TaxonomyNode[]>` — sanitized taxonomy on success.
- **Throws**: Nothing.
- **Description**: Validate an LLM-produced taxonomy payload. Accepts an array of nodes or `{taxonomy: [...]}`. Checks: non-empty names, no `/` in names, well-formed paths (path === parentPath + "/" + name), max depth 3, no duplicate paths. Duplicate leaf names with different parents are allowed.

```typescript
export function validateAssignments(
  json: unknown,
  validPaths: Set<string>,
): { ok: true; value: ItemAssignment[]; droppedPaths: string[] }
 | { ok: false; error: string }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `json` | `unknown` | yes | Parsed JSON payload. |
| `validPaths` | `Set<string>` | yes | Paths that exist in the taxonomy. |

- **Returns**: On success, `{ok: true, value: ItemAssignment[], droppedPaths: string[]}` — `droppedPaths` are paths the LLM produced that were not in `validPaths`. On failure, `{ok: false, error}`.
- **Throws**: Nothing.
- **Description**: Validate a classification payload for one batch. Accepts an array or `{assignments: [...]}`. Each assignment must have a numeric `itemId` and an array of `collectionPaths`. Invalid paths are DROPPED (not thrown). An assignment ending with zero valid paths gets `confidence: "low"` and `collectionPaths: []`. `confidence` is coerced to one of the three allowed values; anything else becomes `"low"`.

```typescript
export function flattenTaxonomyPaths(taxonomy: TaxonomyNode[]): string[]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | yes | Taxonomy tree. |

- **Returns**: `string[]` — every path (root and leaf), depth-first parent-before-child.
- **Throws**: Nothing (pure).
- **Description**: Flatten a taxonomy tree into the list of every path it contains.

```typescript
export function findExistingNameCollisions(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { taxPath: string; taxLeafName: string; existingPath: string }[]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | yes | Proposed taxonomy. |
| `existingPaths` | `string[]` | yes | Existing library collection paths. |

- **Returns**: Array of collisions (empty if none). Each entry: `taxPath`, `taxLeafName`, `existingPath`.
- **Throws**: Nothing (pure).
- **Description**: Detect leaf-name collisions between a proposed taxonomy and the EXISTING library's collection paths — the root cause of the duplicate-collection-name bug. A collision is a taxonomy node the applier would have to CREATE (its full path is NOT in `existingPaths`) AND whose leaf name matches an existing collection's leaf name. A taxonomy node whose full path EXACTLY matches an existing path is a REUSE and is never reported. Exported so `planApplier` can call it from the live-Zotero path and so it is unit-tested under plain Node.

---

## Module: planApplier

The Gate 4 write path: create proposed collections and refile items. All writes via Zotero JS API + `saveTx()` — NO raw SQL. Newly-created collections addressed by numeric `collection.id`, NEVER by `collection.key`. Additive by default. Source: `src/modules/planApplier.ts`.

### Constants

```typescript
export const ITEM_DELAY_MS = 10;
const USER_LIBRARY_ID = 1;
```

`ITEM_DELAY_MS` is the delay between per-item saves (ms). The manual `#Organization` session learned that saving many items in a tight loop can overwhelm Zotero's transaction queue; a 10ms gap avoids that. `USER_LIBRARY_ID` matches `libraryReader.ts:56`.

### Types

```typescript
export interface ApplyOptions {
  replaceExisting: boolean;
  onProgress?: (update: {
    phase: "collections" | "refiling" | "cleanup";
    message: string;
    current: number;
    total: number;
  }) => void;
}

export interface ApplyResult {
  collectionsCreated: number;
  itemsRefiled: number;
  collectionsDeleted: number;
  errors: { itemId: number; error: string }[];
  nameCollisions: { taxPath: string; taxLeafName: string; existingPath: string }[];
}
```

| Interface | Field | Type | Description |
|-----------|-------|------|-------------|
| `ApplyOptions` | `replaceExisting` | `boolean` | If true, remove existing memberships before adding new ones. |
| `ApplyOptions` | `onProgress` | `(update) => void?` | Synchronous progress callback. |
| `ApplyResult` | `collectionsCreated` | `number` | Count of created collections. |
| `ApplyResult` | `itemsRefiled` | `number` | Count of refiled items. |
| `ApplyResult` | `collectionsDeleted` | `number` | Count of empty pre-existing collections deleted (replace mode only). |
| `ApplyResult` | `errors` | `{itemId, error}[]` | Per-item errors (does not abort the apply). |
| `ApplyResult` | `nameCollisions` | `{taxPath, taxLeafName, existingPath}[]` | Skipped taxonomy nodes whose leaf name collides with an existing collection at a different path. |

### Functions

```typescript
export async function applyPlan(
  plan: CategorizationPlan,
  options: ApplyOptions,
): Promise<ApplyResult>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | `CategorizationPlan` | yes | The plan to apply. |
| `options` | `ApplyOptions` | yes | Apply options (must include `replaceExisting`). |

- **Returns**: `Promise<ApplyResult>` — counts, per-item errors, name collisions.
- **Throws**: Nothing — errors are recorded per-item and do not abort the apply. The caller MUST capture a `RevertSnapshot` BEFORE calling this function.
- **Description**: Apply a plan in three phases. (1) Create collections: walk the taxonomy depth-first (parents before children); for each node, check whether a collection with the same name already exists under the resolved parent (path-match); if not, create it via `new Zotero.Collection()` + `saveTx()` and record its numeric `id`. Pre-existing twin collections (same name AND same parent — Zotero permits this) are deduped by keeping the lowest `id` deterministically (`planApplier.ts:143-161`). A pre-apply guard detects leaf-name collisions and skips the offending subtree rather than silently creating a same-named sibling. (2) Refile items: resolve each assignment's paths to IDs; if `replaceExisting`, clear then set; otherwise merge with current IDs (additive). `await item.saveTx()` per item with a `ITEM_DELAY_MS` gap. (3) Cleanup (replace mode only): delete pre-existing collections that are now empty, deepest-first.

```typescript
export function planCollectionCreation(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { toCreate: string[]; toReuse: string[] }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | yes | Proposed taxonomy. |
| `existingPaths` | `string[]` | yes | Existing collection paths. |

- **Returns**: `{toCreate: string[], toReuse: string[]}` — `toCreate` is in dependency order (parents before children).
- **Throws**: Nothing (pure).
- **Description**: Pure helper returning which paths need to be created vs reused. No Zotero globals, no I/O — unit-tested under plain Node. Inlines `flattenPaths` and `leafNameOf` so the module has no relative runtime imports (only type-only imports, erased by `--experimental-strip-types`).

### Re-exports

`export type { ItemAssignment };` — re-exported from `categorizationTypes.ts` so callers can import the assignment type from one place (`planApplier.ts:631`).

---

## Module: revertSnapshot

Pre-state snapshot + revert logic for the Gate 4 write path. Safety rules: NO raw SQL; address newly-created collections by numeric `id`, NEVER by `.key`; snapshot is captured BEFORE any write. Source: `src/modules/revertSnapshot.ts`.

### Constants

```typescript
export const REVERT_DELAY_MS = 10;
const USER_LIBRARY_ID = 1;
```

`REVERT_DELAY_MS` mirrors `planApplier.ITEM_DELAY_MS` to avoid overwhelming Zotero's transaction queue.

### Types

```typescript
export interface ItemMembershipSnapshot {
  itemId: number;
  collectionIDs: number[];
}

export interface RevertSnapshot {
  items: ItemMembershipSnapshot[];
  existingCollectionIDs: Set<number>;
  timestamp: string;
}
```

| Interface | Field | Type | Description |
|-----------|-------|------|-------------|
| `ItemMembershipSnapshot` | `itemId` | `number` | Zotero itemID. |
| `ItemMembershipSnapshot` | `collectionIDs` | `number[]` | Collection IDs at snapshot time. |
| `RevertSnapshot` | `items` | `ItemMembershipSnapshot[]` | Per-item memberships. |
| `RevertSnapshot` | `existingCollectionIDs` | `Set<number>` | Collection IDs that existed before apply (so revert can delete the new empty ones). |
| `RevertSnapshot` | `timestamp` | `string` | ISO timestamp. |

### Functions

```typescript
export async function captureSnapshot(): Promise<RevertSnapshot>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `Promise<RevertSnapshot>` — items + existing collection IDs + timestamp.
- **Throws**: Propagates `Zotero.Items.getAll` / `Zotero.Collections.getByLibrary` errors.
- **Description**: Capture the current membership state of every regular, non-trashed item plus the set of collection IDs that currently exist. MUST be called BEFORE any apply write. Reads only — no `saveTx`, no writes.

```typescript
export async function revertFromSnapshot(
  snapshot: RevertSnapshot,
): Promise<{
  itemsRestored: number;
  collectionsDeleted: number;
  errors: { itemId?: number; error: string }[];
}>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `snapshot` | `RevertSnapshot` | yes | Snapshot to restore from. |

- **Returns**: `Promise<{itemsRestored, collectionsDeleted, errors}>`.
- **Throws**: Nothing — errors are recorded per-item and do not abort the revert.
- **Description**: Restore the library to the state recorded in `snapshot`. For each item, set its collection memberships back to the recorded IDs (full replace). For collections created by the apply (IDs not in `snapshot.existingCollectionIDs`), if empty after restore, delete them via `eraseTx()`. All writes via `item.saveTx()` / `collection.eraseTx()` — no raw SQL.

```typescript
export function serializeSnapshot(snapshot: RevertSnapshot): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `snapshot` | `RevertSnapshot` | yes | Snapshot to serialize. |

- **Returns**: `string` — stable JSON (`existingCollectionIDs` emitted as a sorted array).
- **Throws**: Nothing (pure).
- **Description**: Serialize a snapshot to a stable JSON string. Pure.

```typescript
export function deserializeSnapshot(json: string): RevertSnapshot
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `json` | `string` | yes | Serialized snapshot. |

- **Returns**: `RevertSnapshot` — rebuilt (with `existingCollectionIDs` as a `Set`).
- **Throws**: `Error("snapshot root is not an object")`, `Error("snapshot.items is not an array")`, `Error("snapshot.items[<i>] is not an object")`, `Error("snapshot.items[<i>].itemId is not a finite number")`, `Error("snapshot.items[<i>].collectionIDs is not an array")`, `Error("snapshot.items[<i>].collectionIDs[<j>] is not a finite number")`, `Error("snapshot.existingCollectionIDs is not an array")`, `Error("snapshot.existingCollectionIDs[<j>] is not a finite number")`. Also propagates `JSON.parse` errors.
- **Description**: Parse a `serializeSnapshot` string back into a `RevertSnapshot`. Pure. Shape check is defensive: structural mismatches throw; missing `timestamp` defaults to `""`.

---

## Module: promptBuilder

Pure prompt builders for the two-stage pipeline. Depends only on the dependency-free `LibraryItem` type and `categorizationTypes.ts`. Runs under plain Node with no network. Source: `src/modules/promptBuilder.ts`.

### Constants

```typescript
export const TAXONOMY_SAMPLE_LIMIT = 40;
const ABSTRACT_BUDGET_CHARS = 0;
export const TAXONOMY_SCHEMA_INSTRUCTION = `Return STRICT JSON ...`;
export const CLASSIFICATION_SCHEMA_INSTRUCTION = `Return STRICT JSON ...`;
export const DEFAULT_TAXONOMY_SYSTEM_PROMPT = [...].join("\n");
export const DEFAULT_CLASSIFICATION_SYSTEM_PROMPT = [...].join("\n");
```

| Constant | Value | Why |
|----------|-------|-----|
| `TAXONOMY_SAMPLE_LIMIT` | `40` | Max sample items the taxonomy prompt will serialize. The orchestrator samples down to this many so the prompt fits a typical LLM context window. |
| `ABSTRACT_BUDGET_CHARS` | `0` | Characters of abstract to retain per item in the taxonomy prompt. `0` means abstracts are omitted entirely (titles + venues + dates are enough for taxonomy proposal and keep the prompt small). |
| `TAXONOMY_SCHEMA_INSTRUCTION` | string | The JSON schema description embedded in the taxonomy prompt. Kept as a constant so tests can assert the prompt references it. |
| `CLASSIFICATION_SCHEMA_INSTRUCTION` | string | The JSON schema description embedded in the classification prompt. |
| `DEFAULT_TAXONOMY_SYSTEM_PROMPT` | string | Default Stage 1 system prompt. Extracted so the preferences pane can populate its textarea with the default. |
| `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` | string | Default Stage 2 system prompt. Extracted for the same reason. |

### Functions

```typescript
export function serializeItemForPrompt(item: LibraryItem): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `item` | `LibraryItem` | yes | Item to serialize. |

- **Returns**: `string` — compact one-line-per-field form (`itemId`, `title` (≤200 chars), `venue` (≤80), `date` (≤10), `currentTopCollection`); abstract omitted when `ABSTRACT_BUDGET_CHARS === 0`.
- **Throws**: Nothing (pure).
- **Description**: Serialize a single item to the compact form used in both prompts. Missing fields become empty strings.

```typescript
export function buildTaxonomyPrompt(
  sample: LibraryItem[],
  customSystemPrompt?: string,
): { system: string; user: string }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sample` | `LibraryItem[]` | yes | Sample items. |
| `customSystemPrompt` | `string` | optional | Custom system prompt; falls back to `DEFAULT_TAXONOMY_SYSTEM_PROMPT` if empty/whitespace. |

- **Returns**: `{system: string, user: string}` — message pair.
- **Throws**: Nothing (pure).
- **Description**: Build the system + user messages for Stage 1 (taxonomy proposal). Pure, deterministic.

```typescript
export function buildClassificationPrompt(
  batch: LibraryItem[],
  taxonomyPaths: string[],
  customSystemPrompt?: string,
): { system: string; user: string }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `batch` | `LibraryItem[]` | yes | Items to classify in this call. |
| `taxonomyPaths` | `string[]` | yes | Flat list of every valid taxonomy path. |
| `customSystemPrompt` | `string` | optional | Custom system prompt; falls back to `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT`. |

- **Returns**: `{system: string, user: string}` — message pair.
- **Throws**: Nothing (pure).
- **Description**: Build the system + user messages for Stage 2 (per-item classification). Pure, deterministic.

```typescript
export function buildRetryPrompt(error: string): { system: string; user: string }
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error` | `string` | yes | Validator's human-readable error message. |

- **Returns**: `{system: string, user: string}` — corrective retry message pair.
- **Throws**: Nothing (pure).
- **Description**: Build the corrective retry message appended after a failed LLM response. Sent as a follow-up user message in the SAME conversation, so the LLM retains the original system prompt, the item sample, and its own previous (invalid) output.

---

## Module: organizerUI

Controller for the Smart Organizer review window (Gate 4). Opens the XHTML window, generates a plan, renders the taxonomy tree, and wires up Apply / Revert / Regenerate / Cancel buttons. Source: `src/modules/organizerUI.ts`.

### Functions

```typescript
export async function openReviewWindow(): Promise<void>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `Promise<void>`.
- **Throws**: Propagates `Zotero.getMainWindow().openDialog` errors.
- **Description**: Open the review window and start generating a plan. The window opens immediately in a "generating" state with a live LLM activity log; when the plan is ready, the window swaps to the plan view. If the window is already open, reuses it. The XHTML's `onload` does NOT call into the plugin (the chrome:// window runs in a different scope where `Zotero.SmartOrganizer` is undefined), so the function waits for `load` and calls `initOrganizerUI` directly (`organizerUI.ts:93-107`).

```typescript
export function initOrganizerUI(win: Window): void
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `win` | `Window` | yes | The organizer window. |

- **Returns**: `void`.
- **Throws**: Nothing.
- **Description**: Initialize the review window after its XHTML loads. Wires up button handlers (Apply, Revert, Regenerate, Cancel) using both `command` (XUL) and `click` (fallback) events. If a plan already exists, renders it directly; otherwise starts generating.

### Internal state

```typescript
interface OrganizerWindowState {
  plan: CategorizationPlan | null;
  snapshot: RevertSnapshot | null;
  lastApply: ApplyResult | null;
  window: Window | null;
  selectedPath: string | null;
  progressText: string;
  generating: boolean;
}
```

A single module-level `state` object persists the live plan + snapshot between the menu handler and the window's onload (`organizerUI.ts:52-60`). A single window is supported at a time.

### Internal handlers (not exported)

- `startGenerating(win)` — shows the generating overlay; pushes progress/reasoning lines into in-memory buffers and flushes them to the DOM every 150ms via `setInterval` (XUL elements don't repaint during long async ops). On completion, swaps to plan view.
- `onApply(win)` — captures a snapshot FIRST (safety), then calls `applyPlan` with `replaceExisting: true`; shows a progress overlay; maps the three phases to overall progress (collections 0–10%, refiling 10–95%, cleanup 95–100%).
- `onRevert(win)` — confirms with the user via `Services.prompt.confirm`, then calls `revertFromSnapshot`.
- `onRegenerate(win)` — re-runs `generatePlan` and re-renders; does NOT touch the snapshot or apply state.
- `setStatus(win, message, kind)` — sets the status line (`"info" | "busy" | "success" | "error"`).

### Re-exports

`export { config };` — re-exported for the menu/hook wiring (`organizerUI.ts:719`).

---

## Module: preferenceScript

Preference pane registration and wiring. Source: `src/modules/preferenceScript.ts`.

### Functions

```typescript
export async function registerPrefs(): Promise<void>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `Promise<void>`.
- **Throws**: Propagates `Zotero.PreferencePanes.register` rejections (duplicate pane ID, resolveURI failure, etc.).
- **Description**: Register the preference pane with Zotero. Called once at startup.

```typescript
export async function registerPrefsScripts(win: Window): Promise<void>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `win` | `Window` | yes | The preferences window. |

- **Returns**: `Promise<void>`.
- **Throws**: Nothing — pref read/write errors are caught and logged.
- **Description**: Wire up the preference pane controls when it loads. Initializes each control from the stored pref and persists on change (`command`, `change`, `input`, `blur` events for cross-platform robustness). For the two custom-prompt textareas, if the stored pref is empty, shows the default prompt as the textarea value (without persisting). Wires the "Test connection" button to force-persist all fields, then call `testConnection()`.

---

## Module: domHelpers (utils)

DOM helpers for building dynamic display text inside the XUL organizer window. Source: `src/utils/domHelpers.ts`.

### Constants

```typescript
export const HTML_NS = "http://www.w3.org/1999/xhtml";
```

The XHTML namespace. Used because `doc.createElement("label")` in a XUL-namespaced document creates an HTML-namespace `HTMLLabelElement` whose `.value` does not render text — the migration-safe pattern is to create HTML-namespace elements (`div`/`span`) and use `textContent` (`domHelpers.ts:1-19`).

### Functions

```typescript
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `doc` | `Document` | yes | Owner document (a XUL document in the organizer window). |
| `tag` | `K` | yes | HTML tag name (e.g. `"div"`, `"span"`). |
| `style` | `string` | optional | Inline CSS string (set via the `style` attribute). |
| `text` | `string` | optional | Text content (set via `textContent`). |

- **Returns**: `HTMLElementTagNameMap[K]` — the created element.
- **Throws**: Nothing.
- **Description**: Create an HTML-namespace element with optional inline style and text.

---

## Module: locale (utils)

Locale helpers wrapping Firefox's `Localization` API. Source: `src/utils/locale.ts`.

### Functions

```typescript
export function initLocale(): void
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `void`.
- **Throws**: Nothing.
- **Description**: Initialize locale data. Creates a `Localization` instance for `<addonRef>-addon.ftl` and stores it on `addon.data.locale.current`. Uses `ztoolkit.getGlobal("Localization")` when the global `Localization` is undefined.

```typescript
export function getString(localString: FluentMessageId): string;
export function getString(localString: FluentMessageId, branch: string): string;
export function getString(
  localeString: FluentMessageId,
  options: { branch?: string | undefined; args?: Record<string, unknown> },
): string;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `localString` | `FluentMessageId` | yes | FTL key. |
| `branch` | `string` | optional | Branch name (attribute). |
| `options.branch` | `string` | optional | Branch name. |
| `options.args` | `Record<string, unknown>` | optional | Args for dynamic messages. |

- **Returns**: `string` — resolved message, or the prefixed key as a fallback if missing.
- **Throws**: `Error("Invalid arguments")` if more than 2 arguments are passed.
- **Description**: Get a localized string. See the Fluent tutorial for FTL syntax.

```typescript
export function getLocaleID(id: FluentMessageId): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `FluentMessageId` | yes | FTL key. |

- **Returns**: `string` — `<addonRef>-<id>`.
- **Throws**: Nothing.
- **Description**: Build the prefixed locale ID.

---

## Module: prefs (utils)

Typed wrappers around `Zotero.Prefs`. Source: `src/utils/prefs.ts`.

### Functions

```typescript
export function getPref<K extends keyof PluginPrefsMap>(key: K): PluginPrefsMap[K]
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `K` | yes | Preference key (typed against `PluginPrefsMap`). |

- **Returns**: `PluginPrefsMap[K]` — the stored value.
- **Throws**: Propagates `Zotero.Prefs.get` errors.
- **Description**: Get a preference value (wrapper of `Zotero.Prefs.get`).

```typescript
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
): void
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `K` | yes | Preference key. |
| `value` | `PluginPrefsMap[K]` | yes | Value to set. |

- **Returns**: `void`.
- **Throws**: Propagates `Zotero.Prefs.set` errors.
- **Description**: Set a preference value (wrapper of `Zotero.Prefs.set`).

```typescript
export function clearPref(key: string): void
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | yes | Preference key. |

- **Returns**: `void`.
- **Throws**: Propagates `Zotero.Prefs.clear` errors.
- **Description**: Clear a preference value (wrapper of `Zotero.Prefs.clear`).

---

## Module: window (utils)

Source: `src/utils/window.ts`.

### Functions

```typescript
export function isWindowAlive(win?: Window): boolean
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `win` | `Window` | optional | Window to check. |

- **Returns**: `boolean` — `true` if `win` is defined, not a dead wrapper, and not closed.
- **Throws**: Nothing.
- **Description**: Check if a window is alive. Useful to prevent opening duplicate windows.

---

## Module: ztoolkit (utils)

Constructs and configures the `ZoteroToolkit` instance. Source: `src/utils/ztoolkit.ts`.

### Functions

```typescript
export function createZToolkit(): ZoteroToolkit
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | — |

- **Returns**: `ZoteroToolkit` — configured toolkit instance.
- **Throws**: Propagates `ZoteroToolkit` constructor errors.
- **Description**: Create a `ZoteroToolkit`, set its log prefix to `[<addonName>]`, disable console logging in production, enable element JSON/DOM logging in development, set the plugin ID, and set the default `ProgressWindow` icon to the plugin's favicon. An alternative `MyToolkit` class (extending `BasicTool` with a `UITool`) is defined in live code at `ztoolkit.ts:37-48`, but its instantiation at `ztoolkit.ts:12` is commented out — uncomment line 12 (and remove the `ZoteroToolkit` instantiation) to use it instead, which can reduce plugin size.

---

## Cross-module design notes

- **Pure vs. live modules**: Pure modules (`categorizationTypes`, `libraryModel`, `collectionTree`, `llmRequest`, `planValidator`, `promptBuilder`, and the pure helpers in `planApplier`/`revertSnapshot`) have no Zotero globals and no relative runtime imports (only type-only imports erased by `--experimental-strip-types`), so they unit-test under plain Node. Live modules (`libraryReader`, `llmClient`, `taxonomyStage`, `classificationStage`, `categorizer`, `planApplier`, `revertSnapshot`, `organizerUI`, `preferenceScript`) wrap the pure helpers with Zotero JS API reads/writes and LLM calls.
- **Numeric IDs, never keys**: The write path (`planApplier`, `revertSnapshot`) addresses newly-created collections by numeric `collection.id`, never by `collection.key` — a work-order safety rule learned from a manual session bug.
- **Additive by default**: `applyPlan` is additive unless `replaceExisting: true` is passed (work-order safety rule #3). The UI's Apply button passes `replaceExisting: true` after confirming.
- **Snapshot before write**: `onApply` captures a `RevertSnapshot` BEFORE calling `applyPlan`, so revert can fully restore.
- **fetch over XHR**: `llmClient.chatComplete` uses `fetch()` instead of `Zotero.HTTP.request` because reasoning models hold the connection open while "thinking" — XHR would interpret that silence as a timeout.
- **Throttled UI updates**: Both the generating overlay (`organizerUI.startGenerating`, 150ms timer) and the apply overlay (`onApply`, 150ms timer) accumulate text in plain strings and flush to the DOM on a timer, so per-chunk DOM writes don't starve the main thread. The LLM reasoning chunks are additionally coalesced at most every 80ms in `categorizer.generatePlan` (`categorizer.ts:80-100`).
