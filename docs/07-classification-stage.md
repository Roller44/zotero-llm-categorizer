# Classification Stage

> Stage 2 of the two-stage LLM categorization pipeline (Gate 3): classify each
> item into the taxonomy proposed by Stage 1.

- **Source:** `src/modules/classificationStage.ts`
- **Role in pipeline:** consumes a `LibraryItem[]` (produced by Gate 2 / `libraryModel`) and a `TaxonomyNode[]` tree (produced by Stage 1 / the taxonomy stage), and emits an `ItemAssignment[]` plan that maps every item to one or more taxonomy collection paths plus a confidence label.
- **I/O contract:** this module performs **no Zotero reads** (it works purely off the `LibraryItem[]` handed to it) and **no writes** of any kind. It is a pure transformation — the caller (Gate 4) is responsible for materializing the returned plan into Zotero collections.

---

## 1. Overview

Classifying a library of hundreds of items by issuing one LLM call per item would be both slow and expensive, and would blow past provider rate limits. This module therefore:

1. **Batches** items into groups (default 10 per batch) so a single LLM call classifies many items at once.
2. **Runs the batches concurrently** with a small cap (default 5 in-flight calls) to stay under typical provider rate limits.
3. **Validates** each batch's JSON response against the known taxonomy paths, retrying up to `MAX_RETRIES` times when the response is malformed.
4. **Drops, never throws on, hallucinated paths** — a plan must remain usable even if the LLM invents a path that doesn't exist in the taxonomy. Dropped paths are logged via `Zotero.debug` when available.
5. **Collects** the validated assignments into a single flat `ItemAssignment[]`, re-attaching titles by id so the output is self-describing even when the LLM omits or reorders them.

The public surface is small: `classifyItems()` is the entry point, `batchItems()` is exported for testing, and `DEFAULT_BATCH_SIZE` / `DEFAULT_CONCURRENCY` are exported as the tunable knobs. `classifyBatch()` and `mapWithConcurrency()` are internal helpers.

### A note on the file header

The module's top JSDoc (`classificationStage.ts:5-7`) says the items are "batched (default 20 per call)" and run "concurrently with a small cap (default 3)". The actual constants on lines 36 and 39 are **10 and 5**. The narrative comment is stale; the code is the source of truth. When tuning, trust the constants and the per-call `options` override path, not the prose.

---

## 2. Imports and module boundaries

`classificationStage.ts:14-33`

```ts
import type { LibraryItem } from "./libraryModel";
import type { ItemAssignment, TaxonomyNode } from "./categorizationTypes";
import { chatComplete, safeGetPref, type ChatMessage, type ChunkCallback } from "./llmClient";
import { config } from "../../package.json";
import { buildClassificationPrompt, buildRetryPrompt } from "./promptBuilder";
import { extractJson, flattenTaxonomyPaths, validateAssignments } from "./planValidator";
```

| Import | Used for |
| --- | --- |
| `LibraryItem` | Input item shape (id, title, …). |
| `ItemAssignment`, `TaxonomyNode` | Output shape and taxonomy tree shape. |
| `chatComplete` | The single LLM call primitive. |
| `safeGetPref` | Reads a user-overridable custom system prompt from Zotero prefs without throwing. |
| `ChatMessage`, `ChunkCallback` | Types passed through to `chatComplete`. |
| `config` (from `package.json`) | Provides `config.prefsPrefix` for the pref key. |
| `buildClassificationPrompt`, `buildRetryPrompt` | Construct the system+user messages for the initial call and for retry turns. |
| `extractJson` | Pulls a JSON payload out of an LLM text response. |
| `flattenTaxonomyPaths` | Flattens the `TaxonomyNode[]` tree into a flat list of slash-delimited paths. |
| `validateAssignments` | Validates the parsed JSON into `ItemAssignment[]` and reports dropped paths. |

The separation of concerns is deliberate: this module owns *orchestration* (batching, concurrency, retries, collection). Prompt construction lives in `promptBuilder`, and JSON extraction / structural validation live in `planValidator`. This keeps `classificationStage.ts` focused and unit-testable — the only things in this file that cannot run under plain Node are the `chatComplete` call and the `Zotero.debug` log.

---

## 3. Tunable constants

`classificationStage.ts:35-42`

```ts
/** Default number of items per classification LLM call. Tunable. */
export const DEFAULT_BATCH_SIZE = 10;

/** Maximum concurrent batch LLM calls. Tunable; keeps us under rate limits. */
export const DEFAULT_CONCURRENCY = 5;

/** Maximum retry attempts per batch after a malformed LLM response. */
const MAX_RETRIES = 2;
```

| Constant | Value | Exported? | Meaning |
| --- | --- | --- | --- |
| `DEFAULT_BATCH_SIZE` | `10` | yes | Items packed into a single LLM classification call. Larger = fewer calls but longer prompts and a higher chance of a malformed response. |
| `DEFAULT_CONCURRENCY` | `5` | yes | Maximum number of in-flight `chatComplete` calls. Caps provider load; both knobs are overridable per-call via `classifyItems` options. |
| `MAX_RETRIES` | `2` | no | Retry attempts **after** the first attempt — so a batch is tried up to 3 times total (attempt `0..MAX_RETRIES`). |

---

## 4. `batchItems()` — pure batching helper

`classificationStage.ts:44-57`

### batchItems

Splits `items` into consecutive (contiguous, order-preserving) chunks of length `size`. The final chunk may be shorter.

```ts
export function batchItems<T>(items: T[], size: number): T[][]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `T[]` | Yes | The input array to split into contiguous chunks. |
| `size` | `number` | Yes | The maximum length of each chunk. Must be `> 0`. |

**Returns:** `T[][]` — an array of contiguous chunks of `items`, in input order. The final chunk may be shorter than `size`.

**Throws:** `Error("batch size must be > 0, got ${size}")` when `size <= 0` (`classificationStage.ts:49-51`).

- **Generic.** Operates on `T[]`, not on `LibraryItem[]` specifically — it is exported primarily so tests can assert chunking behavior with plain numbers or strings, without needing LLM fixtures.
- **Guard.** Throws `Error("batch size must be > 0, got ${size}")` when `size <= 0` (`classificationStage.ts:49-51`). There is no upper bound check; the caller chooses.
- **Implementation.** A plain `for` loop with `slice(i, i + size)`. `O(n)` time, `O(n)` space. Order-preserving: `flatten(batchItems(x, n)) === x`.

This is the only public, pure, non-async function in the module, which makes it the natural unit-testing seam for the batching step.

---

## 5. `mapWithConcurrency()` — the semaphore pattern

`classificationStage.ts:59-102`

### mapWithConcurrency

Runs `worker` over every entry of `items`, with at most `limit` workers in flight at any time. Returns results **in input order** (not completion order), by writing each result into a pre-sized array at the worker's `index`.

```ts
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `I[]` | Yes | The input array to map over. |
| `limit` | number | Yes | Maximum number of workers in flight at any time. Must be `> 0`. |
| `worker` | `(item: I, index: number) => Promise<O>` | Yes | Async function invoked once per item with the item and its input index. |

**Returns:** `Promise<O[]>` — the worker results in input order (not completion order).

**Throws:** `Error("concurrency must be > 0, got ${limit}")` when `limit <= 0` (`classificationStage.ts:68-70`). Any worker rejection rejects the whole promise (see "Failure mode" below).

This is a hand-rolled **counting semaphore** — no external dependency. The plugin runs inside Zotero's embedded Firefox runtime and cannot assume an npm concurrency helper is available, so the author implements the smallest correct semaphore. The pattern is the standard "counter + recursive launcher":

### 5.1 State

```ts
const results: O[] = new Array(items.length);
let next = 0;     // index of the next item to LAUNCH
let active = 0;   // number of in-flight workers
```

`results` is pre-allocated to the full length up front so each worker can write its own slot by index — this is what guarantees output order is input order regardless of which worker finishes first.

### 5.2 The `launch` loop

```ts
const launch = () => {
  while (active < limit && next < items.length) {
    const idx = next++;
    active++;
    worker(items[idx], idx)
      .then((r) => { results[idx] = r; })
      .catch(reject)
      .finally(() => {
        active--;
        if (next < items.length) {
          setTimeout(launch, 0);   // yield to the UI macrotask queue
        } else if (active === 0) {
          resolve(results);
        }
      });
  }
};
```

Key points:

- The `while` loop fills the concurrency window up to `limit` in a single synchronous tick. Each `worker` call is fire-and-forget; its `then` writes the result and its `finally` decrements `active` and re-enters `launch`.
- **`setTimeout(launch, 0)` between batches.** Rather than recursing synchronously into `launch` the instant a worker settles, the code schedules the next launch on the next macrotask. The inline comment (`classificationStage.ts:87-88`) explains why: this *yields to the host's UI macrotask queue* so that a long classification run over a large library does not starve paint/input events in the Zotero host. This is a deliberate responsiveness decision, not a correctness requirement — removing the `setTimeout` would still produce correct results but would make the host UI janky for the duration of the run.
- **Failure mode.** Any worker rejection calls `reject` on the outer promise (`classificationStage.ts:83`), which short-circuits the whole `mapWithConcurrency` call. `classifyItems` does not catch this, so a single batch that exhausts its retries fails the entire classification stage. This is intentional: a half-complete plan with silently missing items would be worse than an explicit error (see §7.4).
- **Empty input.** `if (items.length === 0) resolve(results)` short-circuits before calling `launch` (`classificationStage.ts:96-98`), returning an empty array without scheduling any timeouts.

### 5.3 Guards

Throws `Error("concurrency must be > 0, got ${limit}")` when `limit <= 0` (`classificationStage.ts:68-70`).

### 5.4 Why not `Promise.all` over fixed shards?

A naive alternative — split into `limit` contiguous shards and `Promise.all` a worker over each shard — would give the same concurrency but worse load balancing: a shard containing a slow batch would block its entire lane while other lanes sit idle. The semaphore pattern here keeps the window full at all times: the moment any worker settles, the next pending item is launched. For LLM calls whose latency varies widely (a small batch with a clean response is much faster than a large batch that needs retries), this matters.

---

## 6. `classifyBatch()` — one batch, with retries

`classificationStage.ts:104-158`

### classifyBatch

Classifies a single batch of items. Returns the validated assignments plus the list of paths the LLM produced that were **not** in the taxonomy (so the caller can log them). Not exported.

```ts
async function classifyBatch(
  batch: LibraryItem[],
  validPaths: Set<string>,
  onChunk?: ChunkCallback,
): Promise<{ assignments: ItemAssignment[]; droppedPaths: string[] }>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `batch` | `LibraryItem[]` | Yes | The items to classify in this single LLM call. |
| `validPaths` | `Set<string>` | Yes | The set of all known taxonomy paths. Used for O(1) membership checks during validation; hallucinated paths not in this set are dropped. |
| `onChunk` | `ChunkCallback` | No | Streaming hook forwarded verbatim to `chatComplete` so streaming UIs show per-token progress within the batch. |

**Returns:** `Promise<{ assignments: ItemAssignment[]; droppedPaths: string[] }>` — the validated assignments for the batch, plus the list of LLM-produced paths that were not in `validPaths` (for caller-side logging).

**Throws:** `Error("Classification batch failed after ${MAX_RETRIES} retries. Last error: ${lastError}")` if all attempts (initial + `MAX_RETRIES` retries) fail structurally.

### 6.1 Prompt construction

```ts
const customPrompt = safeGetPref(`${config.prefsPrefix}.classificationSystemPrompt`);
const { system, user } = buildClassificationPrompt(
  batch,
  [...validPaths],
  customPrompt.trim() || undefined,
);
```

- The user can override the default classification system prompt via a Zotero pref keyed `<prefsPrefix>.classificationSystemPrompt`. `safeGetPref` reads it without throwing.
- A blank/whitespace-only custom prompt is coalesced to `undefined` (`classificationStage.ts:120`), so `buildClassificationPrompt` falls back to its built-in default. The pref is *opt-in* — unset is the same as "use the bundled prompt".
- `validPaths` is spread into an array because `buildClassificationPrompt` expects an array of path strings, which it serializes into the prompt so the LLM can only choose from known paths.

### 6.2 Initial message list

```ts
let messages: ChatMessage[] = [
  { role: "system", content: system },
  { role: "user", content: user },
];
```

`messages` is declared with `let` because the retry loop appends to it (see §6.4).

### 6.3 The retry loop

```ts
let lastError = "";
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  const raw = await chatComplete(messages, { temperature: 0 }, onChunk);
  const extracted = extractJson(raw);
  if (!extracted.ok) {
    lastError = extracted.error;
  } else {
    const validated = validateAssignments(extracted.value, validPaths);
    if (validated.ok) {
      return { assignments: validated.value, droppedPaths: validated.droppedPaths };
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
throw new Error(`Classification batch failed after ${MAX_RETRIES} retries. Last error: ${lastError}`);
```

The loop body runs at most `MAX_RETRIES + 1` times (initial attempt + 2 retries = 3 total tries).

**Validation cascade.** Each attempt:

1. Calls `chatComplete` with `temperature: 0` for deterministic output. `onChunk` is forwarded so streaming UIs still work.
2. `extractJson(raw)` pulls the JSON payload out of the raw text. If extraction fails, `lastError` records the parse error and the loop continues to the retry branch.
3. If extraction succeeded, `validateAssignments(extracted.value, validPaths)` checks structural validity *and* that every collection path exists in `validPaths`. If validation passes, the function returns immediately with `{ assignments, droppedPaths }`. The `droppedPaths` are paths the LLM produced that were *not* in `validPaths` — `validateAssignments` chose to drop them rather than fail.

### 6.4 The retry mechanism — append-don't-replace

This is the same pattern used by the taxonomy stage. On a failed attempt, the loop does **not** rebuild `messages` from scratch. Instead it appends:

- The **assistant's actual (bad) response** as an `assistant` turn, so the model sees what it just produced.
- A **retry user turn** from `buildRetryPrompt(lastError)`, which tells the model what was wrong (the parse error or the validation error) and asks it to fix its previous output.

```ts
messages = [
  ...messages,
  { role: "assistant", content: raw },
  { role: "user", content: retry.user },
];
```

Why append-don't-replace? Because the model is being asked to *repair* its own output, not to start over. Showing it the broken response it just emitted — plus a targeted diagnostic — is more reliable than re-asking the original question and hoping for a different roll of the dice. This also keeps token usage bounded: each retry adds exactly two turns rather than re-sending the (potentially large) batch + taxonomy-path list, which is already present in the earlier `user` turn and is reused verbatim.

Note that `buildRetryPrompt` returns a `{system, user}` pair but only `retry.user` is used — the system message is *not* appended, so the original system prompt stays in force for the whole conversation.

The `if (attempt < MAX_RETRIES)` guard ensures the append only happens when there is a subsequent attempt to make — otherwise the loop exits and the throw fires.

### 6.5 Two failure modes feed the same retry path

`extractJson` failing (the response wasn't parseable JSON) and `validateAssignments` failing (the JSON parsed but the structure was wrong) both set `lastError` and fall through to the same retry branch. By contrast, `validateAssignments`'s "drop invalid paths" rule does *not* trigger a retry — dropping is reported via `droppedPaths` and the batch succeeds. Only *structural* failures (non-object assignment, non-numeric `itemId`, non-array `collectionPaths`, etc.) retry.

### 6.6 Final failure

If all attempts are exhausted, the function throws:

```ts
throw new Error(`Classification batch failed after ${MAX_RETRIES} retries. Last error: ${lastError}`);
```

This reject propagates up through `mapWithConcurrency`'s `worker` → its `.catch(reject)` → `classifyItems`'s `await` → the caller. There is no per-batch swallowing; a single irreparable batch fails the whole stage (see §7.4 for the rationale).

### 6.7 The confidence field

`classifyBatch` does not compute `confidence` itself — it forwards whatever `validateAssignments` returns inside each `ItemAssignment`. The confidence label (`"high" | "medium" | "low"`) is produced by the LLM in its JSON response and is validated structurally by `planValidator`. Downstream, an item whose every path was dropped ends up with `collectionPaths: []` and `confidence: "low"` (the downgrade happens inside `validateAssignments`, not in this module).

---

## 7. `classifyItems()` — the public entry point

`classificationStage.ts:160-245`

### classifyItems

Classifies every item in `items` against `taxonomy`. Batches the items, runs batches concurrently with retries, drops hallucinated paths, and re-attaches titles by id.

```ts
export async function classifyItems(
  items: LibraryItem[],
  taxonomy: TaxonomyNode[],
  options: {
    batchSize?: number;
    concurrency?: number;
    onBatchDone?: (completed: number, total: number, detail: string) => void;
    onChunk?: ChunkCallback;
  } = {},
): Promise<ItemAssignment[]>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The library items to classify (typically produced by Gate 2 / `libraryModel`). |
| `taxonomy` | `TaxonomyNode[]` | Yes | The taxonomy tree produced by Stage 1; flattened internally to the set of valid collection paths. |
| `options` | `object` | No | Optional configuration object (all fields optional). |
| `options.batchSize` | `number` | No | Items per classification LLM call. Defaults to `DEFAULT_BATCH_SIZE` (10). |
| `options.concurrency` | `number` | No | Maximum in-flight batch calls. Defaults to `DEFAULT_CONCURRENCY` (5). |
| `options.onBatchDone` | `(completed: number, total: number, detail: string) => void` | No | Progress callback fired once per finished batch with the completed count, total batch count, and a human-readable detail string. |
| `options.onChunk` | `ChunkCallback` | No | Streaming hook forwarded verbatim to `chatComplete` for per-token UI updates within a batch. |

**Returns:** `Promise<ItemAssignment[]>` — a flat array of assignments (one per surviving item-path mapping) with titles re-attached by id. Items whose every path was dropped appear with `collectionPaths: []` and `confidence: "low"`. Order is batch-then-item, not necessarily the input `items` order (see §7.5).

**Throws:** `Error` if any batch exhausts its retries (propagated from `classifyBatch` via `mapWithConcurrency`). Hallucinated paths never throw — they are dropped and logged.

### 7.1 Options resolution

```ts
const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
const onBatchDone = options.onBatchDone;
const onChunk = options.onChunk;
```

`batchSize` and `concurrency` fall back to the exported defaults, so callers (and tests) can scale up or down without touching module state. `onBatchDone` and `onChunk` are optional progress/streaming hooks.

### 7.2 Building the valid-path set

```ts
const paths = flattenTaxonomyPaths(taxonomy);
const validPaths = new Set(paths);
```

`flattenTaxonomyPaths` walks the `TaxonomyNode[]` tree and emits slash-delimited paths. Wrapping the array in a `Set` gives `validateAssignments` O(1) path membership checks inside the inner loop — important because validation runs once per (item × path) per batch attempt.

### 7.3 Batching and concurrent execution

```ts
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
```

- `batchItems` produces contiguous batches; the order is preserved through the whole pipeline.
- `mapWithConcurrency` runs up to `concurrency` `classifyBatch` calls at once.
- The worker constructs a human-readable `detail` string for the `onBatchDone` progress callback, including:
  - The 1-indexed `batchIdx + 1` over `batches.length`,
  - The number of items in the batch and the number of assignments produced,
  - The count of dropped invalid paths (only when nonzero),
  - A truncated sample of the first 3 item titles (each capped at 60 chars) so the UI can show which items were in this batch.
- `batchesCompleted` is incremented **after** `classifyBatch` resolves, so the progress count reflects finished batches, not launched ones. (Because `batchesCompleted++` is synchronous within a single worker's `then`-chain, the increment is safe under JavaScript's single-threaded event loop — no locking needed.)
- `onBatchDone` is invoked with the *completed* count, the *total* count, and the `detail` string — this is the primary progress-reporting hook for the UI.

### 7.4 Collecting assignments

`classificationStage.ts:214-244`

```ts
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
```

Two important design decisions live here:

1. **`titleById` re-attachment.** The LLM may return assignments in a different order than the input batch, or omit the `title` field entirely. By building a `Map<itemId, title>` from the original `items`, the collector can restore the correct title for every assignment regardless of ordering or omission: `a.title || titleById.get(a.itemId) || ""` (`classificationStage.ts:235`). The fallback chain is: trust the LLM's title if present → else look up by id → else empty string. This makes the output deterministic and self-describing even when the LLM is sloppy.

2. **Per-batch dropped-path logging, not throwing.** When `validateAssignments` dropped hallucinated paths, those paths are surfaced here as a `Zotero.debug` warning (capped at the first 10, with a trailing `…` if there are more). The `try/catch` around the `Zotero?.debug?.(...)` call guards against environments where the `Zotero` global is unavailable — notably the pure-Node test harness — so the module can be unit-tested without a host. **The plan is never failed because of dropped paths.** Only structural validation failure (a malformed JSON or a missing required field) fails a batch; a path that simply isn't in the taxonomy is silently dropped and the item keeps whatever valid paths remain.

   This is the asymmetry that lets a plan survive a hallucinating model: *structural* problems trigger retries and ultimately a throw; *semantic* problems (invented paths) trigger a warning and a graceful degrade.

### 7.5 Ordering caveat

`classifyItems` returns assignments in *batch then item* order, which is **not** guaranteed to match the input `items` order. `mapWithConcurrency` returns batches in the order they were launched (which is the input batch order), but within a batch the LLM may emit assignments in any order. Callers that need to correlate an assignment back to its item must key on `itemId`, not on array index. The `titleById` map exists precisely to make this id-based correlation robust.

### 7.6 Items with no valid paths

An item whose every proposed path was dropped by `validateAssignments` is returned with `collectionPaths: []` and `confidence: "low"`. The module does not synthesize a fallback path itself — it forwards what survived validation. The caller decides what to do with an empty-path assignment (Gate 4 typically surfaces it for manual placement).

---

## 8. Module invariants & design rationale

| Invariant | Where enforced | Why |
| --- | --- | --- |
| No Zotero reads | `classifyItems` only consumes `items` and `taxonomy` passed in. | Keeps the stage pure and testable; reads belong to Gate 2 (`libraryModel`). |
| No Zotero writes | No write API is imported or called. | Writes belong to Gate 4. The classification stage only *plans*. |
| Output order is deterministic | `mapWithConcurrency` pre-allocates `results` by index; `titleById` restores titles by id. | Predictable plans; the UI can correlate progress to specific items. |
| Hallucinated paths never throw | `validateAssignments` returns `droppedPaths`; `classifyItems` logs them. | A plan must remain usable even with a sloppy model. |
| Structural failure does throw | `classifyBatch` throws after `MAX_RETRIES`; `mapWithConcurrency` rejects. | A half-complete plan with silently missing items is worse than an explicit error. |
| Concurrency is bounded | `mapWithConcurrency` semaphore with `DEFAULT_CONCURRENCY`. | Stays under provider rate limits. |
| Batch size is bounded | `DEFAULT_BATCH_SIZE` (overridable). | Caps prompt size and the blast radius of a single malformed response. |
| UI responsiveness preserved | `setTimeout(launch, 0)` between worker completions. | Yields to the host's macrotask queue so paint/input events are not starved during long runs. |
| Host-optional | `Zotero?.debug?.(...)` wrapped in `try/catch`. | Runs in a pure-Node test harness with no `Zotero` global. |

---

## 9. Extending or modifying this stage

### 9.1 Tuning batch size and concurrency

The two exported constants are defaults; callers override them per-call via `classifyItems({ batchSize, concurrency })`. To change the default globally, edit `DEFAULT_BATCH_SIZE` / `DEFAULT_CONCURRENCY` (`classificationStage.ts:36,39`). Both must remain `> 0`. Raising concurrency without checking the provider's rate limit will produce 429s that surface as thrown errors from `classifyBatch`. There is no runtime config object — keep it that way unless you also add a settings UI.

### 9.2 Changing the retry budget

`MAX_RETRIES` (`classificationStage.ts:42`) is module-private and not overridable per call. If you need a per-call retry budget, promote it to an option on `classifyItems` and thread it through to `classifyBatch`. Be aware that more retries linearly increases worst-case latency for a stuck batch (a retried batch holds its concurrency slot for the full retry sequence).

### 9.3 Custom system prompt

End users override the system prompt via the `<prefsPrefix>.classificationSystemPrompt` Zotero pref. A blank value falls back to the built-in default. To add more prompt customization points, add new `safeGetPref` reads and thread them into `buildClassificationPrompt` — do not build prompts inside `classifyBatch`, as that breaks the orchestration/prompt-construction separation.

### 9.4 Adding a new validation rule

Add it to `planValidator`'s `validateAssignments`, not here. If the new rule should *drop* a path (semantic), return it in `droppedPaths`. If it should *fail* a batch (structural), return `{ ok: false, error }` so the retry loop fires. This module's contract is: structural failures retry then throw; semantic failures drop then log.

### 9.5 Adding a new field to `ItemAssignment`

Add it to the interface in `categorizationTypes.ts`, teach the schema instruction in `promptBuilder` to mention it, and have `validateAssignments` coerce it. `classifyItems` itself only forwards `itemId`, `title`, `collectionPaths`, and `confidence` (`classificationStage.ts:236-241`), so any new field must also be added to that reconstruction.

### 9.6 Progress reporting hooks

- `onBatchDone(completed, total, detail)` fires once per finished batch with a human-readable detail string. Add finer-grained hooks by extending the `options` object; do not repurpose `onChunk`, which is the streaming hook for `chatComplete` and fires per-token.
- `onChunk` is forwarded verbatim to `chatComplete` so streaming UIs show token-by-token progress within a batch.

### 9.7 Testing seams

- `batchItems` is exported and pure — test it directly.
- `mapWithConcurrency` is internal but exercised by `classifyItems`; test it indirectly by passing a fake `worker` and asserting ordering and concurrency limits via `classifyItems({ batchSize: 1, concurrency: 2 })` with stubbed `chatComplete`.
- `classifyBatch`'s retry behavior can be tested by stubbing `chatComplete` to return malformed JSON for the first N calls and a valid payload on call N+1, then asserting the number of calls and the final assignments.

---

## 10. Cross-references

| Symbol | Defined in | Used here for |
| --- | --- | --- |
| `LibraryItem` | `./libraryModel` | Input item shape. |
| `ItemAssignment`, `TaxonomyNode` | `./categorizationTypes` | Output and taxonomy tree shapes. |
| `chatComplete`, `safeGetPref`, `ChatMessage`, `ChunkCallback` | `./llmClient` | LLM call, pref read, types. |
| `buildClassificationPrompt`, `buildRetryPrompt` | `./promptBuilder` | Prompt construction (initial + retry). |
| `extractJson`, `flattenTaxonomyPaths`, `validateAssignments` | `./planValidator` | JSON extraction, tree flattening, structural+semantic validation. |
| `config.prefsPrefix` | `../../package.json` | Pref key prefix. |

Sibling docs: the taxonomy proposal stage (Stage 1) and the plan validator are documented in their own files in `docs/`. This module is the consumer of Stage 1's `TaxonomyNode[]` and the producer of the `ItemAssignment[]` that Gate 4 applies.
