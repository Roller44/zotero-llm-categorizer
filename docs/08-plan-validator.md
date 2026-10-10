# Plan Validator

`src/modules/planValidator.ts` — the pure, dependency-free validation layer for the two-stage LLM categorization pipeline (Gate 3) of the Zotero Smart Organizer plugin.

The validators sit between the LLM's free-form JSON output and the rest of the pipeline. Their job is to take whatever the model actually returns (fenced code blocks, prose-wrapped objects, missing fields, extra commentary keys) and turn it into either a sanitized, structurally-correct `TaxonomyNode[]` / `ItemAssignment[]` or a single error string that drives the retry loop in `categorizer.ts`. They never throw; they always return a discriminated union so callers can branch on `ok` without `try/catch`.

The file header (`planValidator.ts:1-14`) lays out the design contract:

- **Pure.** Only imports the interface-only `categorizationTypes.ts` (`planValidator.ts:16`). No Zotero globals, no config, no network. This is what makes the validators unit-testable under plain Node with `--experimental-strip-types`, satisfying the work-order requirement that the Gate 3 logic be testable without the host application.
- **Strict on structure, lenient on extras.** Unknown object keys are silently dropped — LLMs routinely add helpful-looking commentary fields, and rejecting those would cause retry cascades.
- **Never throws.** Every function returns a discriminated result so the retry loop in `categorizer.ts` is just `if (!res.ok) { retry(res.error); }`.

## Public API at a glance

| Export | Kind | Purpose |
|---|---|---|
| `ValidationResult<T>` | type | Discriminated union returned by every validator (`planValidator.ts:105-107`). |
| `MAX_TAXONOMY_DEPTH` | `const` | Hard cap on taxonomy tree depth, `= 3` (`planValidator.ts:110`). |
| `extractJson(text)` | function | Pull a JSON value out of a raw LLM string (`planValidator.ts:33`). |
| `validateTaxonomy(json)` | function | Validate & sanitize an LLM taxonomy payload (`planValidator.ts:202`). |
| `validateAssignments(json, validPaths)` | function | Validate & sanitize an LLM classification payload (`planValidator.ts:269`). |
| `flattenTaxonomyPaths(taxonomy)` | function | Depth-first list of every path in a tree (`planValidator.ts:359`). |
| `findExistingNameCollisions(taxonomy, existingPaths)` | function | Detect leaf-name collisions against the live library (`planValidator.ts:403`). |

## The `ValidationResult<T>` type

```ts
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```
(`planValidator.ts:105-107`)

**Fields:**

| Name | Type | Description |
|------|------|-------------|
| `ok` | `true` | Discriminant for the success branch. |
| `value` | `T` | The sanitized payload on success. |
| `error` | `string` (only on `ok: false`) | Specific error message naming the offending path, depth, or index. |

This is the universal return shape. `extractJson` and `validateTaxonomy` use it directly. `validateAssignments` uses a wider variant of the same shape (see below) that adds a `droppedPaths` array on the success branch. The two-branch discriminated union is the reason the retry loop needs no `try/catch`: a missing field, a malformed path, and a network-flavored parse error all surface as `{ ok: false, error }` and flow through the same code path. Error strings are deliberately specific (naming the offending path, depth, or index) so they can be fed straight back to the LLM via `buildRetryPrompt`.

## `MAX_TAXONOMY_DEPTH`

```ts
export const MAX_TAXONOMY_DEPTH = 3;
```
(`planValidator.ts:110`) — Hard cap on taxonomy tree depth: root / child / grandchild, e.g. `SemanticComm/JSCC/Analog`.

The cap is enforced in `validateNode` (`planValidator.ts:168-173`): a node at `depth >= MAX_TAXONOMY_DEPTH` that carries a non-empty `children` array is rejected with `"node ... exceeds max depth 3"`. The depth is 1-indexed (`planValidator.ts:119-122`), so root nodes are depth 1, and the check fires when a depth-3 node tries to introduce depth-4 children. The constant is exported so prompt builders and tests reference the same bound.

### extractJson

Pulls a JSON value out of an LLM text response that may be wrapped in markdown fences or surrounded by stray prose.

```ts
export function extractJson(text: string): ValidationResult<unknown>
```
(`planValidator.ts:33-103`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `text` | `string` | Yes | The raw LLM response text (may be `null`/empty; coerced via `?? ""`). |

**Returns:** `ValidationResult<unknown>` — `{ ok: true, value }` with the parsed JSON value, or `{ ok: false, error }` describing why extraction failed.

**Throws:** None. Pure and never throws — all parse failures surface as `{ ok: false, error }`.

The LLM is prompted to return strict JSON, but in practice it wraps output in markdown fences or surrounds it with prose, so `extractJson` runs a three-step strategy (`planValidator.ts:22-31`):

1. **Direct parse** (`planValidator.ts:40-44`) — `JSON.parse(trimmed)`. Works for the strict-spec case and is the only path that handles bare arrays/objects with no decoration.
2. **Fenced code block** (`planValidator.ts:47-57`) — matches ```` ```json ... ``` ```` or ```` ``` ... ``` ```` via `/```(?:json)?\s*([\s\S]*?)```/i` and parses the captured body. If a fence is found but its body is not valid JSON, the function returns `{ ok: false, error: "fenced block was not valid JSON: ..." }` and does **not** fall through to step 3 — once a fenced block is identified, a parse failure there is the real error.
3. **First balanced object/array substring** (`planValidator.ts:60-102`) — scans for the first `{` or `[`, then walks the string tracking bracket depth and string literals (with escape handling, `planValidator.ts:67-100`) until depth returns to zero, and parses that slice. This is what recovers JSON from `"Sure! {\"a\":{\"b\":2}} Hope that helps."`. The string-literal tracking is critical: braces inside strings (`{"s":"he said {not json}"}`, exercised at `categorization.test.ts:600-606`) must not perturb the depth counter.

Empty/whitespace-only input returns `{ ok: false, error: "empty response" }` (`planValidator.ts:35-37`). Input with no `{` or `[` at all returns `"no JSON object or array found in response"` (`planValidator.ts:61-63`). Unbalanced brackets return `"unbalanced JSON in response"` (`planValidator.ts:102`).

`extractJson` is exported so that both `taxonomyStage.ts` and `classificationStage.ts` share one extraction strategy, and so the strategy itself is unit-tested (`categorization.test.ts:558-616`).

### validateTaxonomy

Validates & sanitizes an LLM-produced taxonomy payload, returning a sanitized `TaxonomyNode[]` or an error.

```ts
export function validateTaxonomy(json: unknown): ValidationResult<TaxonomyNode[]>
```
(`planValidator.ts:202-253`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `unknown` | Yes | The parsed JSON payload — either a bare array of root nodes or the `{ taxonomy: [...] }` wrapper. |

**Returns:** `ValidationResult<TaxonomyNode[]>` — on success, the sanitized tree (each node rebuilt with only `name`, `path`, `description`, `children`); on failure, an error string prefixed with `root[i]:` indicating the offending root (`planValidator.ts:228`).

**Throws:** None — returns a discriminated result.

The core taxonomy validator. Accepts either:

- a bare array of root nodes, or
- the strict-schema wrapper `{ taxonomy: [...] }`.

Anything else — a non-array scalar, an object without a `taxonomy` field — is rejected with `"taxonomy payload is not an array and has no `taxonomy` array"` (`planValidator.ts:213-217`). An empty array (or empty `taxonomy`) is rejected with `"taxonomy is empty"` (`planValidator.ts:219-221`) — a non-empty tree is required so the pipeline produces at least one collection.

### Validation rules

The validator walks each root through `validateNode` and then deduplicates the entire tree by path. The rules, in the order they are checked:

| Rule | Where enforced | Error string fragment |
|---|---|---|
| Payload is an array or `{taxonomy:[...]}` | `planValidator.ts:204-217` | `is not an array and has no \`taxonomy\` array` |
| At least one root node | `planValidator.ts:219-221` | `taxonomy is empty` |
| Each node is an object | `planValidator.ts:124-126` | `is not an object` |
| Each node has a non-empty string `name` (after `trim()`) | `planValidator.ts:129-135` | `empty or non-string name` |
| Names contain no `/` | `planValidator.ts:138-143` | `contains a '/'` |
| `path` matches the expected `parentPath + '/' + name` | `planValidator.ts:145-154` | `does not match expected` |
| Tree depth ≤ `MAX_TAXONOMY_DEPTH` (3) | `planValidator.ts:168-173` | `exceeds max depth` |
| No duplicate **paths** anywhere in the tree | `planValidator.ts:236-248` | `duplicate taxonomy path` |

Unknown keys on a node are dropped — the validator rebuilds each node from only `name`, `path`, `description`, and `children` (`planValidator.ts:188`).

### The recursive core: `validateNode()`

Recursively validates one `TaxonomyNode` candidate and returns a sanitized node (with non-string fields coerced and unknown keys dropped) or an error.

```ts
function validateNode(
  raw: unknown,
  parentPath: string,
  depth: number,
): ValidationResult<TaxonomyNode>
```
(`planValidator.ts:119-189`) — internal, not exported.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `raw` | `unknown` | Yes | The candidate node object from the LLM payload. |
| `parentPath` | `string` | Yes | The path the node MUST report (root nodes pass `""` and report their own name; children report `parentPath + '/' + name`). |
| `depth` | `number` | Yes | 1-indexed depth in the tree (root = 1). |

**Returns:** `ValidationResult<TaxonomyNode>` — sanitized node on success; on failure, an error string naming the offending field/path/depth.

**Throws:** None.

The internal recursive helper. `parentPath` is the path the node MUST report (root nodes report their own name; children report `parentPath + '/' + name`), and `depth` is 1-indexed. It performs all per-node checks (non-empty name, no `/`, path match, max depth) and recurses into `children`, accumulating sanitized nodes. It is not exported — callers go through `validateTaxonomy`.

Two design decisions in `validateNode` are worth calling out:

1. **Names cannot contain `/`** (`planValidator.ts:138-143`). The path invariant the whole module relies on is `path === join(names, '/')`. If a name could contain `/`, that invariant would break: a name `"A/B"` with no parent would produce path `"A/B"`, indistinguishable from a node `A` with child `B`. Rejecting `/` in names makes the path-prefix rule self-enforcing and is what lets the dedup logic rely on string-equality of paths alone.

2. **Path is recomputed, not trusted.** The validator does not accept whatever `path` the LLM supplied — it computes `expectedPath` from `parentPath + name` and rejects if the supplied path doesn't match (`planValidator.ts:145-154`). This catches the LLM drift where a node's reported path doesn't line up with its position in the tree, which would otherwise silently misroute items at classification time. The test at `categorization.test.ts:184-198` exercises a node whose `path` is `"WrongRoot"` while its `name` is `"SemanticComm"`.

The comment at `planValidator.ts:183-187` notes that cycles are impossible by construction — paths are derived from names, names can't contain `/`, so a child's path can never equal an ancestor's path. The `seenPaths` set in `validateTaxonomy` is therefore a true structural uniqueness check, not a cycle check.

### Why duplicate PATHS are rejected but duplicate LEAF NAMES are not

This is the most important design decision in the file, and the comment block at `planValidator.ts:230-234` is explicit about it:

> Two nodes may share a leaf name (e.g. `"Wireless/MACProtocols"` and `"Wired/MACProtocols"`) — those are legitimate distinct collections with different parents, so we do NOT reject on duplicate names. Duplicate PATHS (same name at the same position) are still rejected because they'd collapse into one collection.

The dedup walk (`planValidator.ts:235-248`) uses a `Set<string>` of full paths, never of leaf names. A duplicate path means the same collection would be created twice and the two subtree definitions might disagree, which is a genuine structural error. A duplicate leaf name under different parents is two distinct collections that happen to share a name — Zotero allows this (siblings under different parents may share a name), and the LLM produces it routinely for natural taxonomies.

The test at `categorization.test.ts:293-332` (`accepts duplicate leaf names with different paths`) locks this behavior in. Its comment explains the practical reason: rejecting duplicate leaf names **causes the LLM retry cascade to fail** — the model loses context on retry and produces garbage. The lenient rule is not just permissive; it is what keeps the pipeline converging. The opposite case — two children both named `B` under the same `A`, both producing path `A/B` — is a true structural error and is rejected (`categorization.test.ts:253-281`).

### The duplicate-name bug (historical)

The companion function `findExistingNameCollisions` (below) exists specifically because of a real bug in an earlier version of the applier. The earlier `validateTaxonomy` rejected *any* duplicate leaf name across the tree, which (a) rejected legitimate taxonomies and (b) still didn't catch the actual failure mode — a proposed leaf name colliding with an *already-existing* collection in the user's library. The current design splits these concerns: `validateTaxonomy` only checks the proposed tree's internal consistency (unique paths), and `findExistingNameCollisions` separately checks the proposed tree against the live library. The two functions together encode the rule: *inside the taxonomy, paths must be unique; against the existing library, leaf-name collisions on nodes that need to be CREATED are flagged for review.*

### Return value

On success, `validateTaxonomy` returns `{ ok: true, value: TaxonomyNode[] }` where each node has been **sanitized**: `name`, `path`, `description`, and `children` are guaranteed to be present and correctly typed, and any unknown keys the LLM added are dropped (`planValidator.ts:188`). The sanitized tree is what the rest of the pipeline consumes. On failure, the error string is prefixed with `root[i]:` (`planValidator.ts:228`) so the retry prompt can tell the LLM which root node was at fault.

### validateAssignments

Validates & sanitizes an LLM-produced per-batch classification payload, dropping paths not present in the validated taxonomy.

```ts
export function validateAssignments(
  json: unknown,
  validPaths: Set<string>,
): { ok: true; value: ItemAssignment[]; droppedPaths: string[] }
 | { ok: false; error: string }
```
(`planValidator.ts:269-353`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `json` | `unknown` | Yes | The parsed classification payload — a bare array of assignment objects or the `{ assignments: [...] }` wrapper. |
| `validPaths` | `Set<string>` | Yes | Set of paths that exist in the validated taxonomy (typically `new Set(flattenTaxonomyPaths(taxonomy))`). Assignment paths not in this set are dropped, not fatal. |

**Returns:** A discriminated union — on success, `{ ok: true, value: ItemAssignment[], droppedPaths: string[] }` (the sanitized assignments plus every path that was filtered out); on failure, `{ ok: false, error: string }`. The inline return type (rather than reusing `ValidationResult`) is the narrowest type that exposes the `droppedPaths` field the caller needs for telemetry/logging.

**Throws:** None — returns a discriminated result.

Validates the per-batch classification payload. Like `validateTaxonomy`, it accepts either a bare array or the wrapper `{ assignments: [...] }` (`planValidator.ts:281-295`); anything else is rejected with `"classification payload is not an array and has no `assignments` array"`.

Each assignment must have:

- **`itemId`** — numeric, or coercible to a finite number (`planValidator.ts:308-314`). A non-finite id is rejected with `"assignment[i] has non-numeric itemId"`.
- **`collectionPaths`** — an array (`planValidator.ts:319-325`). Non-array is rejected. Each element must be a string; non-strings are silently skipped (`planValidator.ts:328-330`).
- **`title`** and **`confidence`** — optional/coerced. `title` defaults to `""` (`planValidator.ts:316-317`). `confidence` is coerced to `"high"`, `"medium"`, or `"low"`; anything else (including missing) becomes `"low"` (`planValidator.ts:338-342`).

### The "filter, do not throw" rule

The key design choice: an assignment path that is **not** in `validPaths` is **dropped, not fatal** (`planValidator.ts:326-336`). Dropped paths are recorded in the `droppedPaths` array on the success branch so the caller can log a warning. This implements the work order's "filter, do not throw" rule (`planValidator.ts:262-265`) — a single hallucinated path must not abort the whole batch.

If an assignment ends up with zero valid paths after filtering, its `collectionPaths` is forced to `[]` and its `confidence` is forced to `"low"` (`planValidator.ts:344-349`). This lets the review UI (Gate 4) surface the item as "unfiled / low-confidence" rather than rejecting the entire plan.

`validPaths` is the set of paths that exist in the validated taxonomy — typically `new Set(flattenTaxonomyPaths(taxonomy))`. The caller in `classificationStage.ts` builds this set once per batch. The success branch carries `droppedPaths` because the caller needs it for telemetry/logging; the inline return type (rather than reusing `ValidationResult`) is the narrowest type that exposes that field.

### Test coverage

`validateAssignments` is exercised at `categorization.test.ts:336-454`: valid assignments, bare-array form, path filtering with `droppedPaths` recorded, zero-valid-paths coercion to low confidence, missing/invalid confidence coercion to `"low"`, and the three rejection cases (non-numeric `itemId`, non-array `collectionPaths`, non-array payload).

### flattenTaxonomyPaths

Flattens a taxonomy tree into the list of every path it contains (root and leaf, all depths), depth-first, parent-before-child.

```ts
export function flattenTaxonomyPaths(taxonomy: TaxonomyNode[]): string[]
```
(`planValidator.ts:359-370`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The validated taxonomy tree (root nodes). |

**Returns:** `string[]` — every path in the tree, depth-first, parent-before-child.

**Throws:** None. Pure and non-recursive (uses an explicit stack), so it cannot stack-overflow on a degenerate deep tree.

Implementation is an explicit stack (`planValidator.ts:361-368`) seeded with the roots in reverse so that popping yields left-to-right order; children are also pushed in reverse so each subtree likewise comes out parent-first. (Though `validateTaxonomy` would already have rejected depth > 3.)

For the fixture taxonomy (`categorization.test.ts:54-83`), the output is `["SemanticComm", "SemanticComm/JSCC", "SemanticComm/JSCC/Analog", "ChannelCoding"]` (`categorization.test.ts:458-466`).

`flattenTaxonomyPaths` is the bridge between the validated taxonomy and the two consumers that need a flat path list:

- `classificationStage.ts` uses it to build the `validPaths` set passed to `validateAssignments`.
- `findExistingNameCollisions` uses it to iterate the proposed tree.

Keeping it standalone makes both call sites readable and gives the traversal its own unit tests (`categorization.test.ts:458-477`).

### findExistingNameCollisions

Detects leaf-name collisions between a proposed taxonomy and the user's existing library collection paths — the root cause of the duplicate-collection-name bug.

```ts
export function findExistingNameCollisions(
  taxonomy: TaxonomyNode[],
  existingPaths: string[],
): { taxPath: string; taxLeafName: string; existingPath: string }[]
```
(`planValidator.ts:403-437`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taxonomy` | `TaxonomyNode[]` | Yes | The validated proposed taxonomy tree. |
| `existingPaths` | `string[]` | Yes | Full collection paths already present in the user's live Zotero library. |

**Returns:** `{ taxPath: string; taxLeafName: string; existingPath: string }[]` — one entry per (proposed node, conflicting existing collection) pair. Empty if no collisions. Each entry names the offending taxonomy path (`taxPath`), its leaf name (`taxLeafName`), and the conflicting existing path (`existingPath`).

**Throws:** None. Pure: no Zotero globals, no I/O.

This is the function that exists specifically to prevent the duplicate-collection-name bug, described in the long comment at `planValidator.ts:381-401`.

### The bug it prevents

In `planApplier.applyPlan`, a taxonomy node whose full path is **not** already in the library must be **created**. Zotero's collection-creation API identifies a new collection by (name, parent). If a proposed node's leaf name matches an *existing* collection's leaf name but the full paths differ, the applier would silently create a brand-new, same-named collection under a different parent. The library would then contain two distinct collections that share a name but hold different papers — exactly the duplicate-name bug.

`findExistingNameCollisions` is the pre-apply guard against this. `planApplier` calls it from the live-Zotero path with the library's actual `existingPaths`; if it returns a non-empty list, the apply is aborted (or surfaced for user confirmation) before any collection is created.

### What counts as a collision

A collision is a taxonomy node that **(a)** the applier would have to CREATE — its full path is NOT in `existingPaths` (so `pathToID.get(node.path)` would be `undefined` in the applier) — **AND (b)** whose LEAF name matches an existing collection's leaf name (`planValidator.ts:386-391`).

A taxonomy node whose full path **exactly** matches an existing path is a **reuse**: the applier will reuse the existing collection, not create a new one, so it is **never** reported as a collision (`planValidator.ts:392-396`, `planValidator.ts:422-425`). This is true even if some *other* existing collection shares its leaf name — that pre-existing duplicate is not something this apply would create, so it is out of scope.

### Why leaf names and not full paths

Zotero collections are addressed by ID, but the applier creates new collections by name under a parent. If a taxonomy node has leaf name `Theory` and is to be created under `SemanticComm`, the applier calls Zotero's "create child collection named `Theory` under `SemanticComm`." If a top-level `Theory` already exists in the library, the result is two distinct collections named `Theory` — both visible in the UI, both holding different papers, indistinguishable at a glance. That is the duplicate-name bug. The validator's job here is to surface this case before the applier runs so the caller (or the user) can decide whether to rename, reuse, or skip.

### Implementation

#### leafNameOf

Returns the leaf-name component of a slash-delimited collection path (the substring after the last `/`). A path with no `/` returns itself. Pure.

```ts
function leafNameOf(path: string): string
```
(`planValidator.ts:376-379`) — internal helper, not exported.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | Yes | A slash-delimited collection path. |

**Returns:** `string` — the substring after the last `/`, or the whole path if there is no `/`.

**Throws:** None.

`findExistingNameCollisions` (`planValidator.ts:403-437`):

1. Builds `existingSet = new Set(existingPaths)` for O(1) reuse lookup.
2. Builds `existingByLeaf: Map<string, string[]>` grouping every existing path by its leaf name (`planValidator.ts:408-417`).
3. Iterates `flattenTaxonomyPaths(taxonomy)`. For each `taxPath`:
   - If `existingSet.has(taxPath)`, skip — it's a reuse, not a collision (`planValidator.ts:422-425`).
   - Otherwise look up `existingByLeaf.get(leaf)`. If there are candidates, **every** candidate is reported as a separate collision entry (`planValidator.ts:426-434`). The comment at `planValidator.ts:431` notes that since `taxPath` is not in `existingSet`, every candidate path necessarily differs from it, so no false self-collisions.

Each returned entry names the offending taxonomy path (`taxPath`), its leaf name (`taxLeafName`), and the conflicting existing path (`existingPath`). When one leaf name is shared by multiple existing collections, all of them are reported — the test at `categorization.test.ts:532-546` verifies this with a `NewArea/Theory` proposal against `["Theory", "OldArea/Theory"]`, expecting two collision entries.

### Purity and call sites

The function is pure: no Zotero globals, no I/O. It is exported so `planApplier` can call it from the live-Zotero path as a pre-apply guard, and so it is unit-testable under plain Node. The expected call pattern is: build the `existingPaths` list from the live library, call `findExistingNameCollisions(taxonomy, existingPaths)`, and either log the collisions or surface them to the user before applying.

## How the validators fit together

```
LLM text ──► extractJson ──► validateTaxonomy ──► TaxonomyNode[]
                                              │
                                              ├─► flattenTaxonomyPaths ──► validPaths:Set
                                              │                              │
                                              └─► findExistingNameCollisions(existingPaths[])
                                                     │
                                                     ▼
                                              planApplier (pre-apply guard)

LLM text ──► extractJson ──► validateAssignments(json, validPaths) ──► ItemAssignment[]
```

A typical Gate 3 run calls these functions in this order:

1. **Taxonomy stage** — `taxonomyStage.ts` calls `extractJson(llmText)` → `validateTaxonomy(json)`. On failure, the error string feeds `buildRetryPrompt` and the LLM is retried (capped). On success, the sanitized `TaxonomyNode[]` is stored.
2. **Classification stage** — `classificationStage.ts` calls `flattenTaxonomyPaths(taxonomy)` to build `validPaths`, then for each batch: `extractJson(llmText)` → `validateAssignments(json, validPaths)`. Dropped paths are logged; the sanitized `ItemAssignment[]` is stored.
3. **Apply stage** (Gate 4, `planApplier.ts`) — before creating any collection, calls `findExistingNameCollisions(taxonomy, existingPaths)` with the live library's paths. A non-empty result aborts the apply so the user can resolve the collision.

The split between `validateTaxonomy` (internal consistency of the proposed tree) and `findExistingNameCollisions` (proposed tree vs. live library) is deliberate: the former is pure and runs inside the retry loop; the latter needs library state and runs once, just before the destructive apply. This keeps the retry loop hermetic and pushes the I/O-dependent check to the latest possible moment. On any `{ ok: false }`, the stage module calls `buildRetryPrompt` with the error string and re-queries the LLM (the retry cascade). This is why the error strings are specific and why the validators do not throw — the retry loop is straight-line code, not a `try/catch`.

## Extending the validators

- **Add a structural rule** (e.g. enforce a max description length): add the check inside `validateNode` for per-node rules, or inside the `validateTaxonomy` loop for whole-tree rules. Return `{ ok: false, error: ... }` with a descriptive message that can be fed to `buildRetryPrompt`. Do not throw.
- **Loosen a rule**: prefer loosening in `validateNode`/`validateTaxonomy` rather than at a call site, so all callers benefit and the unit tests pin the new behavior.
- **Change the depth cap** — edit `MAX_TAXONOMY_DEPTH` (`planValidator.ts:110`). The check at `planValidator.ts:168` is the only place that references it. Bump the depth-4 test (`categorization.test.ts:200-235`) accordingly.
- **Add a new assignment-level rule** — add it inside the per-assignment loop in `validateAssignments` (`planValidator.ts:299-350`). Remember the "filter, do not throw" rule: prefer dropping/coercing a bad field over returning `{ ok: false }`, so a single bad assignment doesn't abort the whole batch.
- **New collision semantics** in `findExistingNameCollisions`: the function is intentionally pure and returns data; do not make it side-effecting. If the caller wants to auto-rename or auto-skip, do that in `planApplier`, not here.
- **Adding a new payload shape**: follow the existing pattern — accept both the bare array and the `{ key: [...] }` wrapper form at the top of the validator, and return a discriminated result.

## Unit test coverage

The validator's behavior is pinned by the no-network unit tests in `test/categorization.test.ts`. Run with:

```
node --test --experimental-strip-types test/categorization.test.ts
```

The test file imports only the dependency-free modules (`categorization.test.ts:14-29`) and runs under plain Node, fulfilling the work-order requirement that Gate 3 logic be testable without Zotero or network.

### `validateTaxonomy` tests

| Test | File:line | Asserts |
|---|---|---|
| accepts a valid tree | `categorization.test.ts:152-161` | Returns 2 roots, walks `SemanticComm → JSCC → Analog` |
| accepts the `{taxonomy:[...]}` wrapper form | `categorization.test.ts:163-166` | Strict schema form is accepted |
| rejects empty names | `categorization.test.ts:168-182` | Error matches `/empty or non-string name/` |
| rejects malformed paths | `categorization.test.ts:184-198` | Error matches `/does not match expected/` |
| rejects depth > 3 | `categorization.test.ts:200-235` | A four-deep tree errors with `/exceeds max depth/` |
| rejects name containing `/` | `categorization.test.ts:237-251` | Error matches `/contains a '\/'/` |
| rejects duplicate paths | `categorization.test.ts:253-281` | Two children both named `B` under `A` → `/duplicate taxonomy path/` |
| rejects non-array, non-wrapper input | `categorization.test.ts:283-286` | `{foo:1}` fails |
| rejects empty taxonomy | `categorization.test.ts:288-291` | `[]` fails |
| accepts duplicate leaf names with different paths | `categorization.test.ts:293-332` | `Wireless/MACProtocols` and `Wired/MACProtocols` both pass — the rule that prevents the retry-cascade failure |

### `findExistingNameCollisions` tests

| Test | File:line | Asserts |
|---|---|---|
| detects leaf-name collision at a different path | `categorization.test.ts:481-501` | `SemanticComm/Theory` vs existing `Theory` → 1 collision |
| reuse at exact path is NOT a collision | `categorization.test.ts:503-511` | `Theory` vs existing `Theory` → 0 collisions |
| no collision when leaf name is unique | `categorization.test.ts:513-519` | `ChannelCoding` vs `Theory`, `SemanticComm` → 0 |
| empty existing paths → no collisions | `categorization.test.ts:521-526` | `[]` existing → 0 |
| empty taxonomy → no collisions | `categorization.test.ts:528-530` | `[]` taxonomy → 0 |
| reports all conflicting existing paths for one leaf | `categorization.test.ts:532-546` | Two existing `Theory`s → 2 collisions, both naming the same `taxPath` |
| detects collision at root level (top-level reuse) | `categorization.test.ts:548-556` | A top-level `ML` matching an existing top-level `ML` is a reuse, not a collision |

### `flattenTaxonomyPaths` tests

| Test | File:line | Asserts |
|---|---|---|
| returns all paths depth-first parent-before-child | `categorization.test.ts:458-466` | Order is `SemanticComm`, `SemanticComm/JSCC`, `SemanticComm/JSCC/Analog`, `ChannelCoding` |
| empty taxonomy → empty array | `categorization.test.ts:468-470` | `[]` → `[]` |
| single root → `[path]` | `categorization.test.ts:472-477` | Single `Solo` node → `["Solo"]` |

### `validateAssignments` tests

`categorization.test.ts:336-454`. Cover: valid assignments accepted; bare array form accepted; invalid paths filtered and recorded in `droppedPaths`; zero valid paths forces `confidence: "low"` and empty `collectionPaths`; missing/invalid confidence coerced to `"low"`; non-numeric `itemId` rejected; non-array `collectionPaths` rejected; non-array payload rejected.

### `extractJson` tests

`categorization.test.ts:560-616`. Cover: bare object; bare array; ```` ```json ```` fence; bare ```` ``` ```` fence; balanced object extracted from surrounding prose; braces inside strings handled correctly; empty input rejected; prose with no JSON rejected.

## Summary of design decisions

1. **Pure and dependency-free** so the validators run under plain Node and are fully unit-testable (`planValidator.ts:1-14`).
2. **Never throw — return a discriminated result** so the retry loop is straight-line code (`planValidator.ts:105-107`).
3. **Strict on structure, lenient on extras** — unknown keys are dropped, not rejected (`planValidator.ts:188`).
4. **Dedup on full paths, not leaf names** — duplicate leaf names under different parents are legitimate; duplicate paths collapse into one collection and are rejected (`planValidator.ts:230-234`). This rule exists because the previous name-based check caused both false rejections (breaking the retry cascade) and the duplicate-collection-name bug.
5. **Path is recomputed, not trusted** — the LLM's reported `path` must match `parentPath + name`, catching model drift (`planValidator.ts:145-154`).
6. **Names cannot contain `/`** — makes the path invariant self-enforcing and lets the dedup logic rely on string equality alone (`planValidator.ts:138-143`).
7. **`findExistingNameCollisions` is a separate, pure pre-apply guard** — the validator cannot know about the existing library, so leaf-name collisions against existing collections are surfaced by a dedicated function that the applier calls from the live-Zotero path (`planValidator.ts:381-402`).
8. **`validateAssignments` filters instead of throwing** — invalid paths are dropped and recorded, not fatal, per the work order's "filter, do not throw" rule (`planValidator.ts:262-265`).
