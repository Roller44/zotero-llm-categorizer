# Categorization Pipeline (Categorizer)

`src/modules/categorizer.ts` is the **orchestration core** of the two-stage LLM
categorization pipeline (Gate 3 of the Smart Organizer). It ties together the
read-only library reader (Gate 2), the taxonomy-proposal stage (Stage 1), and
the per-item classification stage (Stage 2), and produces a single, pure-data
`CategorizationPlan` that Gate 4's review UI consumes.

The shared data model — `TaxonomyNode`, `ItemAssignment`, `CategorizationPlan`,
and the `stats` block — lives in `src/modules/categorizationTypes.ts`. That file
contains *only* TypeScript interfaces (zero runtime, zero imports), so it can be
imported by both the pure, no-Zotero logic (`promptBuilder.ts`,
`planValidator.ts`) and the orchestration modules that *do* touch Zotero and the
network (`taxonomyStage.ts`, `classificationStage.ts`, `categorizer.ts`).

> **Read-only guarantee.** Nothing in this gate writes to the Zotero database,
> creates collections, changes tags, or saves anything. The plan is a proposal
> until Gate 4 (`planApplier.ts`) applies it. This separation is what makes the
> plan reviewable and the pipeline safe to re-run.

---

## 1. The three stages of `generatePlan()`

### generatePlan

Orchestrates the full categorization pipeline: read library → propose taxonomy → classify items → assemble plan.

```ts
export async function generatePlan(
  onProgress?: (update: ProgressUpdate) => void,
): Promise<CategorizationPlan>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `onProgress` | `(update: ProgressUpdate) => void` | No | Progress callback invoked synchronously at each milestone (e.g. to update a `ProgressWindow` in the UI). |

**Returns:** `Promise<CategorizationPlan>` — the full categorization plan (taxonomy + assignments + stats + model + timestamp).

**Throws:** `Error` if `readLibrary`, `proposeTaxonomy`, or `classifyItems` rejects. `generatePlan` performs no `try/catch`, so any rejection — including a malformed-LLM-response exhaustion in `classifyItems` or a network/HTTP error from `chatComplete` — propagates verbatim to the caller.

`generatePlan` (`categorizer.ts:49`) runs three sequential stages and emits a
final `done` event. Every stage writes a `Zotero.debug` log on entry and exit,
and every stage transition calls `onProgress` so a UI `ProgressWindow` can
render live state.

| # | Stage       | `stage` value   | What happens                                                            | Calls into                                          |
|---|-------------|-----------------|-------------------------------------------------------------------------|-----------------------------------------------------|
| 1 | Reading     | `"reading"`     | Read the live library into a pure `LibraryItem[]`.                      | `readLibrary()` (`libraryReader.ts:55`)             |
| 2 | Taxonomy    | `"taxonomy"`    | Sample items, send up to 3 LLM calls (1 + 2 retries), parse a hierarchical taxonomy. | `sampleForTaxonomy`, `proposeTaxonomy` (`taxonomyStage.ts:45`, `:80`) |
| 3 | Classifying | `"classifying"` | Batch all items and classify them concurrently against the taxonomy.    | `classifyItems` (`classificationStage.ts:169`)      |
| — | Done        | `"done"`        | Stats computed, plan assembled, returned.                               | `computeStats` (`categorizer.ts:181`)               |

A separate `"reasoning"` stage value is *not* a pipeline stage — it is emitted
opportunistically by the reasoning-chunk callback (see §4) whenever an LLM
stream sends a thinking-trace delta, regardless of which pipeline stage is
currently running.

### 1.1 Stage 1 — Reading the library

```ts
onProgress?.({ stage: "reading", message: "Reading library…" });
const items = await readLibrary();
```
(`categorizer.ts:53`, `:55`)

`readLibrary()` is Gate 2's read-only entry point (`libraryReader.ts:55`). It
returns the in-memory `LibraryItem[]` model (typed in `libraryModel.ts`). After
it resolves, `generatePlan` immediately emits a second `"reading"` update with
the count (`categorizer.ts:59`). If the library is empty, the pipeline still
proceeds — Stage 2 will sample zero items, Stage 3 will run zero batches, and
`computeStats` will return an all-zero plan rather than throwing.

### 1.2 Stage 2 — Taxonomy proposal

```ts
const sample = sampleForTaxonomy(items);              // categorizer.ts:64
const taxonomy = await proposeTaxonomy(items, taxCb, onChunk);  // :102
```

`sampleForTaxonomy` (re-exported from `categorizer.ts:258`, defined at
`taxonomyStage.ts:45`) picks a representative subset of the library for the
**progress UI only** — the `sample.length` reported in the "Sampling N items"
status message (`categorizer.ts:66-70`) uses `DEFAULT_SAMPLE_SIZE = 150`
(`taxonomyStage.ts:31`).

The actual LLM-bound sample is taken **inside** `proposeTaxonomy`
(`taxonomyStage.ts:85`), which calls `sampleForTaxonomy(items,
TAXONOMY_SAMPLE_LIMIT)` with `TAXONOMY_SAMPLE_LIMIT = 40`
(`promptBuilder.ts:23`). So the progress UI may report up to 150 sampled items
while the LLM receives at most 40. `generatePlan` passes the full `items`
array to `proposeTaxonomy`, not the `sample` variable — that variable exists
only for the status message.

`proposeTaxonomy` (`taxonomyStage.ts:80`) makes **up to 3 LLM calls** (1
initial + 2 retries, `MAX_RETRIES = 2` at `taxonomyStage.ts:42`) and returns
the proposed `TaxonomyNode[]` tree. On a malformed first response the retry
mechanism appends the bad response + a correction prompt to the conversation
(see `06-taxonomy-stage.md` for the full retry logic).

Two callbacks are threaded into `proposeTaxonomy`:

- **`taxCb`** — a per-step detail callback that surfaces Stage-1 progress text
  (e.g. "Sending N item titles…") to the UI as `stage: "taxonomy"` updates
  (`categorizer.ts:103`).
- **`onChunk`** — the shared reasoning-chunk callback (see §4). It is the *same*
  callback used in Stage 3, so a reasoning model's thinking trace is surfaced
  uniformly across the whole pipeline.

After `proposeTaxonomy` resolves, `generatePlan` flushes any trailing reasoning
deltas (`categorizer.ts:110`), flattens the taxonomy into slash-delimited paths
via `flattenTaxonomyPaths` (`planValidator.ts:359`), and emits a final
`"taxonomy"` update listing the top-level areas (`categorizer.ts:116`). The
flat path list is what Stage 3 validates every assignment against.

### 1.3 Stage 3 — Batch classification

```ts
const totalBatches = Math.ceil(items.length / DEFAULT_BATCH_SIZE);  // categorizer.ts:122
const assignments = await classifyItems(items, taxonomy, {         // :134
  onBatchDone, onChunk,
});
```

`DEFAULT_BATCH_SIZE` is **10** items per LLM call (`classificationStage.ts:36`).
Batches run with a concurrency cap of **5** (`DEFAULT_CONCURRENCY`,
`classificationStage.ts:39`) via the internal `mapWithConcurrency` helper. So
the concurrency model lives in `classificationStage.ts`, not here —
`generatePlan` only configures the callbacks:

- `onBatchDone(completed, total, detail)` (`categorizer.ts:135`) is invoked by
  `classifyItems` after each batch finishes. `generatePlan` wraps it into a
  `stage: "classifying"` `ProgressUpdate` carrying `current`/`total` so the UI
  can render a determinate progress bar.
- `onChunk` is the same reasoning callback from Stage 2.

The opening `"classifying"` update (`categorizer.ts:126`) is emitted *before*
`classifyItems` is called and seeds the progress bar with `current: 0,
total: totalBatches`. Note the human-readable `detail` line states "Running 3
batches concurrently" — this is a stale comment string; the actual cap is 5
(see `classificationStage.ts:39`). The detail string is display-only and does
not affect execution, but a developer editing the concurrency default should
update that string too.

### 1.4 Done — assembling the plan

After Stage 3 returns, `generatePlan`:

1. Emits the final `"classifying"` `Zotero.debug` line with the assigned-count
   fraction (`categorizer.ts:147`).
2. Emits `stage: "done"` (`categorizer.ts:151`).
3. Computes `stats` via `computeStats` (`categorizer.ts:157`).
4. Reads the active model from Zotero prefs (`{prefsPrefix}.model`,
   `categorizer.ts:160`) so the plan is reproducible — falls back to
   `"(unknown)"` if unset.
5. Stamps `generatedAt` with `new Date().toISOString()`.
6. Returns the assembled `CategorizationPlan`.

### 1.5 Error propagation

`generatePlan` does **no** `try/catch`. Any rejection from `readLibrary`,
`proposeTaxonomy`, or `classifyItems` propagates verbatim to the caller. In
particular:

- `classifyItems` rejects if **any single batch** exhausts its
  `MAX_RETRIES = 2` retries on a malformed LLM response
  (`classificationStage.ts:155`). Because `mapWithConcurrency` wires worker
  rejections straight to the outer `reject` (`classificationStage.ts:83`), one
  bad batch aborts the entire stage — the pipeline is *not* designed to return a
  partial plan with some items unfiled due to LLM failure. (An item whose
  assignment paths *all* fail validation against the taxonomy, however, is kept
  with `collectionPaths: []` and `confidence: "low"` — see
  `classificationStage.ts:167`. That is a *soft* failure: the LLM answered, just
  badly.)
- Invalid assignment paths (LLM hallucinations) are *dropped with a warning*,
  never thrown — `classificationStage.ts:9` documents this contract, and it is
  the reason the plan "must remain usable even if the LLM hallucinates a path."
- Network/HTTP errors from `chatComplete` (`llmClient.ts:154`, `:164`) bubble
  up through both stages unchanged.

Callers (e.g. the UI button handler in `organizerUI.ts`) are expected to wrap
`generatePlan` in their own `try/catch` and surface the error to the user.

---

## 2. The `ProgressUpdate` callback interface

### ProgressUpdate

Progress callback invoked during `generatePlan` to report milestones. `stage` is `"reading"`, `"taxonomy"`, `"classifying"`, `"reasoning"`, or `"done"`. For `"classifying"`, `current` and `total` report batch progress. For `"reasoning"`, `detail` carries the latest LLM thinking-trace delta.

```ts
export interface ProgressUpdate {
  stage: "reading" | "taxonomy" | "classifying" | "done" | "reasoning";
  message: string;
  detail?: string;
  current?: number;
  total?: number;
}
```
(`categorizer.ts:33`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stage` | `"reading" \| "taxonomy" \| "classifying" \| "done" \| "reasoning"` | Yes | The pipeline stage this update belongs to (see table in §1). |
| `message` | `string` | Yes | Short, single-line headline for a `ProgressWindow`. |
| `detail` | `string` | No | Longer multi-line text for the log panel (e.g. "Stage 1: Sending…"). |
| `current` | `number` | No | For `"classifying"`: batches completed so far. Else undefined. |
| `total` | `number` | No | For `"classifying"`: total batch count. Else undefined. |

`generatePlan` accepts an optional `onProgress: (update: ProgressUpdate) => void`
and calls it **synchronously** at each milestone. The callback is optional at
every call site — `onProgress?.(...)` is used throughout, so passing `undefined`
is safe and produces a "headless" run with no UI updates (useful for tests).

`"reasoning"` updates carry the latest thinking-trace delta in `detail` and the
literal `message: "LLM is reasoning…"`; they have no `current`/`total`. They
can be interleaved with any other stage, because the reasoning callback fires
from the SSE reader on the network thread of the in-flight LLM call.

---

## 3. The data model (`categorizationTypes.ts`)

This module is deliberately import-free so it can be shared between pure and
impure code. Nothing here is applied to the library.

### 3.1 `TaxonomyNode`

A node in the proposed taxonomy tree.

```ts
export interface TaxonomyNode {
  name: string;
  path: string;            // unique key, e.g. "SemanticComm/JSCC/Analog"
  children: TaxonomyNode[];
  description: string;
}
```
(`categorizationTypes.ts:20`)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Human-readable collection name, e.g. "SemanticComm". |
| `path` | `string` | Full slash-delimited path from root (e.g. `"SemanticComm/JSCC/Analog"`). The unique key used downstream. |
| `children` | `TaxonomyNode[]` | Child nodes. `[]` for leaf collections. |
| `description` | `string` | One-sentence justification the LLM gave for the area. |

`path` is the slash-delimited route from the root and is the **unique key** used
everywhere downstream — it is what `flattenTaxonomyPaths` extracts and what
`validateAssignments` checks every assignment against. `children` is `[]` for
leaves. `description` is the one-sentence justification the LLM gave for the
area; `generatePlanSummary` re-prints it in the indented tree view.

### 3.2 `ItemAssignment`

One item's proposed placement in the plan.

```ts
export interface ItemAssignment {
  itemId: number;
  title: string;
  collectionPaths: string[];
  confidence: "high" | "medium" | "low";
}
```
(`categorizationTypes.ts:39`)

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | The `LibraryItem.id` this assignment is for. |
| `title` | `string` | The item's title (carried for the review UI; not used for logic). |
| `collectionPaths` | `string[]` | Proposed collection paths. An item may belong to multiple. |
| `confidence` | `"high" \| "medium" \| "low"` | Heuristic confidence derived from the LLM's stated confidence and whether any of its paths survived validation. |

An item may belong to multiple collections, so `collectionPaths` is an array.
`itemId` matches `LibraryItem.id` from Gate 2. `title` is carried purely for the
review UI; `classifyItems` re-attaches it from the input items even if the LLM
omits it or returns items out of order (`classificationStage.ts:216`).

`confidence` is a *heuristic* — derived from the LLM's own stated confidence and
whether any of its paths survived validation (`categorizationTypes.ts:36`). An
item that ended up with `collectionPaths: []` after path validation is marked
`confidence: "low"` (see `classificationStage.ts:167`); it remains in the plan
so the reviewer can see that the LLM tried and failed.

### 3.3 `CategorizationPlan`

The full output of the categorization pipeline. Gate 4 renders this object in a review UI; nothing here is applied to the library.

```ts
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
(`categorizationTypes.ts:54`)

| Field | Type | Description |
|-------|------|-------------|
| `taxonomy` | `TaxonomyNode[]` | The proposed taxonomy tree (root nodes). |
| `assignments` | `ItemAssignment[]` | Per-item assignments. Length = number of items read. |
| `stats` | (inline object) | Stats block for the review UI (see §3.4). |
| `model` | `string` | The LLM model used, for reproducibility. |
| `generatedAt` | `string` | ISO timestamp of when the plan was generated. |

The full output of the pipeline. `assignments.length` equals the number of items
read (`totalItems`), in the *batch* order produced by Stage 3 — not necessarily
the input order. `model` and `generatedAt` exist for reproducibility: a
reviewer can see at a glance which model produced the plan and when.

### 3.4 `PlanStats` (inline `stats`)

The `stats` block is defined inline on `CategorizationPlan` rather than as a
named export. `computeStats` returns `CategorizationPlan["stats"]`
(`categorizer.ts:185`), which keeps the type coupled to the plan and avoids a
redundant `PlanStats` name in the public surface.

| Field | Type | Description |
|-------|------|-------------|
| `totalItems` | `number` | Passed in (the length of the read `LibraryItem[]`). |
| `itemsWithAssignment` | `number` | `assignments.filter(a => a.collectionPaths.length > 0).length` (`categorizer.ts:186`). |
| `itemsUnfiled` | `number` | `totalItems - itemsWithAssignment`. |
| `totalCollections` | `number` | `flattenTaxonomyPaths(taxonomy).length` — counts every node, not just leaves (`categorizer.ts:189`). |
| `topLevelCollections` | `number` | `taxonomy.length` — count of root areas. |

---

## 4. The reasoning-chunk callback

Reasoning models (e.g. Kimi-K3, OpenAI o-series, Anthropic thinking) emit a
thinking trace alongside their content. `llmClient.ts` exposes a `ChunkCallback`
type:

```ts
export type ChunkCallback = (kind: "content" | "reasoning", text: string) => void;
```
(`llmClient.ts:55`)

`generatePlan` builds a single `onChunk` callback at `categorizer.ts:93` and
threads it into *both* `proposeTaxonomy` (Stage 2) and `classifyItems`
(Stage 3). The callback only handles `kind === "reasoning"` deltas — content
chunks are accumulated internally by `chatComplete` and ignored here.

**Why the throttle?** A fast stream can deliver hundreds of reasoning deltas
per second. Forwarding each one as a `ProgressUpdate` would saturate the UI even
if the DOM-writing path is itself throttled. `generatePlan` coalesces reasoning
deltas into a buffer and flushes at most every **80 ms**:

```ts
let reasoningBuffer = "";
let lastReasoningFlush = 0;
const REASONING_FLUSH_MS = 80;
const flushReasoning = () => { /* emit a "reasoning" ProgressUpdate, reset buffer */ };
const onChunk: ChunkCallback = (kind, text) => {
  if (kind === "reasoning") {
    reasoningBuffer += text;
    if (Date.now() - lastReasoningFlush >= REASONING_FLUSH_MS) flushReasoning();
  }
};
```
(`categorizer.ts:80`–`100`)

After Stage 2 completes, `generatePlan` calls `flushReasoning()` once more
(`categorizer.ts:110`) so trailing deltas that did not meet the 80 ms window are
not lost. Stage 3 reuses the same `onChunk`, so its reasoning is throttled by
the same buffer. The 80 ms window is a UI-pacing constant, not a network
constant — the underlying `readSSEStream` already yields to the host's
macrotask queue at ~16 ms intervals (`llmClient.ts:236`) to keep the Zotero
window responsive.

---

## 5. The concurrency model — `mapWithConcurrency`

The concurrency primitive lives in `classificationStage.ts`, but it is the
backbone of Stage 3 and is worth understanding when reading `generatePlan`.

### mapWithConcurrency

Runs an async worker over each item with a bounded concurrency cap, preserving input order in the resolved array.

```ts
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]>
```
(`classificationStage.ts:63`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `I[]` | Yes | Input items to map over. |
| `limit` | `number` | Yes | Maximum in-flight workers. Must be > 0. |
| `worker` | `(item: I, index: number) => Promise<O>` | Yes | Async function invoked per item with its input index. |

**Returns:** `Promise<O[]>` — the resolved results in input order regardless of completion order.

**Throws:** `Error` if `limit <= 0` (`classificationStage.ts:68`) or `size <= 0` (`classificationStage.ts:50`). Worker rejections propagate straight to the outer promise — the first failing batch aborts the whole stage (no per-batch isolation).

- **Order preservation.** Results are written into a pre-sized `results` array
  at the *input* index (`classificationStage.ts:71`, `:81`), so the resolved
  array is in input order regardless of completion order.
- **Semaphore pattern.** A `next` cursor and `active` counter cap in-flight
  workers at `limit`. The `launch` loop fills the window, then each
  `finally` block (`classificationStage.ts:84`) decrements `active` and either
  launches the next task or resolves the outer promise.
- **`setTimeout(launch, 0)` between batches.** When a worker finishes, the next
  launch is scheduled as a *macrotask*, not a microtask
  (`classificationStage.ts:89`). This deliberately yields to the host's
  paint/input queue so a large library does not freeze the Zotero window. A
  `Promise.resolve()` microtask would not give the paint queue a turn — the
  same reasoning used by `readSSEStream` (`llmClient.ts:234`).
- **Fast-fail.** `worker` rejections are wired straight to `reject`
  (`classificationStage.ts:83`), so the first batch failure aborts the whole
  stage. There is no per-batch isolation; this is a deliberate choice (fail
  loudly rather than return a silently-partial plan).
- **Validation.** `limit <= 0` and `size <= 0` both throw
  (`classificationStage.ts:68`, `:50`).

`classifyItems` calls `mapWithConcurrency(batches, concurrency, worker)`
(`classificationStage.ts:192`) where each worker runs `classifyBatch` — which
itself retries up to `MAX_RETRIES = 2` times on malformed JSON
(`classificationStage.ts:129`) before rejecting.

---

## 6. `computeStats` and `generatePlanSummary`

### 6.1 `computeStats`

### computeStats

Computes the summary stats block of a `CategorizationPlan`. Pure.

```ts
export function computeStats(
  totalItems: number,
  taxonomy: TaxonomyNode[],
  assignments: ItemAssignment[],
): CategorizationPlan["stats"]
```
(`categorizer.ts:181`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `totalItems` | `number` | Yes | The length of the read `LibraryItem[]`. |
| `taxonomy` | `TaxonomyNode[]` | Yes | The proposed taxonomy tree. |
| `assignments` | `ItemAssignment[]` | Yes | Per-item assignments produced by Stage 3. |

**Returns:** `CategorizationPlan["stats"]` — the inline stats block (`totalItems`, `itemsWithAssignment`, `itemsUnfiled`, `totalCollections`, `topLevelCollections`).

**Throws:** None.

Pure. Counts assigned/unfiled items and the total/top-level collection count.
`totalCollections` is `flattenTaxonomyPaths(taxonomy).length`, which counts
*every* node in the tree, not just leaves — a depth-3 area with two children
contributes 3 to `totalCollections`.

### 6.2 `generatePlanSummary`

### generatePlanSummary

Renders a `CategorizationPlan` as a human-readable summary string for the debug log and the review-UI header. Pure (no Zotero globals).

```ts
export function generatePlanSummary(plan: CategorizationPlan): string
```
(`categorizer.ts:204`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `plan` | `CategorizationPlan` | Yes | The plan to render. |

**Returns:** `string` — a multi-line summary (header line, one-line stats summary, indented taxonomy tree, top 5 collection paths by item count).

**Throws:** None.

Pure (no Zotero globals). Renders the plan as a human-readable string for the
debug log and (later) the review-UI header:

1. A header line with `generatedAt`.
2. A one-line summary: model, totals, assigned/unfiled, collection counts.
3. The full taxonomy tree, indented via the internal `renderNode` helper
   (`categorizer.ts:245`). `renderNode` is recursive and prints each node as
   `- name (path) — description`, recursing into `children` with
   `"  ".repeat(depth)` indentation.
4. The **top 5** collection paths by item count. Counts are aggregated from
   `assignments`, sorted descending by count with `localeCompare` as a
   tiebreaker (`categorizer.ts:231`), and printed as `count\tpath`. If there
   are no assignments, the line reads `(no assignments)`.

---

## 7. Re-exports

```ts
export { sampleForTaxonomy };
```
(`categorizer.ts:258`)

`sampleForTaxonomy` is defined in `taxonomyStage.ts:45` and re-exported here so
callers (e.g. a future Gate 4 UI or a test harness) can drive Stage 1's
sampling in isolation without depending on `taxonomyStage.ts` directly. This is
a documented re-export of a pure helper and does not modify Gate 1 or Gate 2.

---

## 8. Design decisions and rationale

1. **Read-only at this gate.** The plan is a pure data object; no writes happen
   until Gate 4. This makes the plan reviewable, idempotent, and safe to re-run.
   Stated in the file header (`categorizer.ts:1`–`13`) and enforced by the type
   signatures — `generatePlan` returns a `CategorizationPlan`, never `void`.
2. **Type-only shared module.** `categorizationTypes.ts` has zero imports so it
   can be safely imported by both pure and impure code without dragging Zotero
   or network dependencies into the pure logic
   (`categorizationTypes.ts:1`–`12`).
3. **Reasoning throttling.** The 80 ms `REASONING_FLUSH_MS` window exists to
   prevent a fast reasoning stream from fanning out hundreds of progress
   updates per second and saturating the UI (`categorizer.ts:74`–`79`).
4. **macrotask yields, not microtasks.** Both `mapWithConcurrency`
   (`classificationStage.ts:88`) and `readSSEStream` (`llmClient.ts:236`) use
   `setTimeout(..., 0)` to yield. A microtask would not give the paint/input
   queue a turn, and the Zotero window would freeze on large libraries or fast
   streams.
5. **Soft-fail on hallucinated paths; hard-fail on malformed responses.** An
   LLM that returns a path not in the taxonomy gets that path silently dropped
   and a warning logged; the item is kept with `confidence: "low"` if all its
   paths were dropped. An LLM that returns unparseable JSON exhausts its
   retries and the *whole stage* rejects. This asymmetry keeps the plan usable
   for "the LLM answered, just imperfectly" while still surfacing genuine
   protocol failures (`classificationStage.ts:8`–`13`).
6. **No `try/catch` in `generatePlan`.** Errors propagate verbatim so the UI
   layer can decide how to surface them. This keeps the orchestrator small and
   avoids swallowing rejections into a misleading "done" state.
7. **Model + timestamp on the plan.** `model` and `generatedAt` are stamped on
   every plan for reproducibility, so a reviewer can tell which model produced
   a given proposal and when (`categorizer.ts:159`–`170`).
8. **`stats` is inline, not a named `PlanStats`.** Coupling the stats shape to
   `CategorizationPlan["stats"]` keeps the public surface minimal and ensures
   the producer (`computeStats`) and the consumer (the plan) cannot drift.

---

## 9. How to extend

- **Add a stage.** Insert it between the existing stages inside `generatePlan`,
  emit a new `stage` value via `onProgress`, and add the value to the
  `ProgressUpdate["stage"]` union (`categorizer.ts:34`). Keep it read-only —
  writes belong in Gate 4.
- **Tune concurrency or batch size.** Edit `DEFAULT_BATCH_SIZE` /
  `DEFAULT_CONCURRENCY` in `classificationStage.ts:36`–`39`. If you change the
  concurrency default, also update the human-readable detail string at
  `categorizer.ts:129` ("Running 3 batches concurrently"), which is currently
  stale relative to the actual cap of 5.
- **Change the reasoning throttle.** Edit `REASONING_FLUSH_MS`
  (`categorizer.ts:82`). Lowering it gives a smoother thinking-trace display at
  the cost of more UI updates; raising it coalesces more aggressively.
- **Surface content chunks.** The `onChunk` callback currently ignores
  `kind === "content"` deltas (`categorizer.ts:94`). To stream the model's
  final answer live, extend the `if` to handle `"content"` and emit a new
  `ProgressUpdate` stage (e.g. `"answering"`).
- **Add a stat.** Extend the inline `stats` block on `CategorizationPlan`
  (`categorizationTypes.ts:60`), compute it in `computeStats`
  (`categorizer.ts:181`), and render it in `generatePlanSummary`
  (`categorizer.ts:204`). Because `computeStats` returns
  `CategorizationPlan["stats"]`, the compiler will flag every site that needs
  updating.
