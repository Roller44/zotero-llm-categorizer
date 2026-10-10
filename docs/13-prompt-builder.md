# Prompt Builder

`src/modules/promptBuilder.ts` — the pure, deterministic prompt-construction layer for the plugin's two-stage LLM categorization pipeline. It owns the **system prompts**, the **JSON schema instructions**, the **per-item serializer**, and the three `build*Prompt()` functions that turn a `LibraryItem[]` batch plus a taxonomy into the `{system, user}` message pairs consumed by `chatComplete()` in `llmClient.ts`.

This module is deliberately dependency-free: it imports only the `LibraryItem` *type* from `libraryModel.ts` (`promptBuilder.ts:15`), which itself has no Zotero globals and no relative imports. That makes the prompt builders runnable under plain Node with `--experimental-strip-types` and no network — a hard requirement of the Gate 3 work order, so the prompts can be unit-tested without booting Zotero (see the module docstring, `promptBuilder.ts:1-13`).

## Module exports at a glance

| Export | Kind | Purpose |
| --- | --- | --- |
| `TAXONOMY_SAMPLE_LIMIT` | `const number` | Max sample size the taxonomy prompt is sized for (`:23`). |
| `TAXONOMY_SCHEMA_INSTRUCTION` | `const string` | Embedded JSON shape for Stage 1 (`:32`). |
| `CLASSIFICATION_SCHEMA_INSTRUCTION` | `const string` | Embedded JSON shape for Stage 2 (`:61`). |
| `DEFAULT_TAXONOMY_SYSTEM_PROMPT` | `const string` | Default Stage 1 system prompt (`:77`). |
| `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` | `const string` | Default Stage 2 system prompt (`:106`). |
| `serializeItemForPrompt(item)` | `function` | Compact one-line-per-field item serializer (`:143`). |
| `buildTaxonomyPrompt(sample, custom?)` | `function` | Stage 1 message pair (`:171`). |
| `buildClassificationPrompt(batch, paths, custom?)` | `function` | Stage 2 message pair (`:206`). |
| `buildRetryPrompt(error)` | `function` | Corrective retry message pair (`:247`). |

The internal `truncate(text, max)` helper (`:131`) and the `ABSTRACT_BUDGET_CHARS` constant (`:26`) are not exported.

---

## Constants

### `TAXONOMY_SAMPLE_LIMIT`

```ts
export const TAXONOMY_SAMPLE_LIMIT = 40; // promptBuilder.ts:23
```

Max sample size the taxonomy prompt is sized for. The orchestrator is responsible for sampling down to ≤ 40 items before calling `buildTaxonomyPrompt()`.

**Value:** `40`

The prompt builder does not enforce this cap itself — the orchestrator is responsible for sampling down to ≤ 40 items before calling `buildTaxonomyPrompt()`. The constant is exported primarily so the abstract-truncation budget can be computed against a known upper bound, and so callers/tests can reference the same value. See the docstring at `:18-22`.

### `ABSTRACT_BUDGET_CHARS`

```ts
const ABSTRACT_BUDGET_CHARS = 0; // promptBuilder.ts:26
```

The number of characters of each item's `abstract` to retain in the serialized prompt.

**Value:** `0`

**Currently `0`**, which means abstracts are *omitted entirely* from both prompts. The serializer still has a guarded branch (`serializeItemForPrompt:159-161`) that emits an `abstract:` line only when this constant is greater than zero, so re-enabling abstracts is a one-line change. The design rationale: the taxonomy stage is meant to be cheap and to fit comfortably in a typical LLM context window even at the full 40-item sample, and the title/venue/date/top-collection signal was judged sufficient for proposing a taxonomy. Bumping this constant is the supported way to give the model more signal per item at the cost of tokens.

### `TAXONOMY_SCHEMA_INSTRUCTION`

```ts
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
}`; // promptBuilder.ts:32-56
```

Embedded JSON shape for Stage 1.

**Value:** the recursive `taxonomy` array shape shown above.

The JSON shape the Stage 1 model must return. The shape is a recursive `taxonomy` array of nodes, each carrying a `name`, a slash-delimited `path`, a one-sentence `description`, and a `children` array (empty at the leaf). The schema is shown to depth 3 in the prompt itself, mirroring the "Maximum depth 3" hard constraint in `DEFAULT_TAXONOMY_SYSTEM_PROMPT`. Note the explicit `children: []` on the depth-3 example — this signals to the model that leaves are terminated with an empty array rather than omitted.

This string is concatenated into the default system prompt at `:99` (`"- " + TAXONOMY_SCHEMA_INSTRUCTION`), so any test that wants to assert "the prompt mentions the schema" can match against this exported constant rather than re-deriving it.

### `CLASSIFICATION_SCHEMA_INSTRUCTION`

```ts
export const CLASSIFICATION_SCHEMA_INSTRUCTION = `Return STRICT JSON (no markdown fences, no prose) matching this shape:
{
  "assignments": [
    {
      "itemId": <number, must match an id from the batch>,
      "collectionPaths": ["<path from the taxonomy, 1 to 3 paths>"],
      "confidence": "high" | "medium" | "low"
    }
  ]
}`; // promptBuilder.ts:61-70
```

Embedded JSON shape for Stage 2.

**Value:** the `assignments` array shape shown above.

The JSON shape the Stage 2 model must return. Each assignment object binds an `itemId` (which must match an `id` from the batch) to an array of 1–3 `collectionPaths` and a `confidence` enum of `high | medium | low`. The schema is appended to the default classification system prompt at `:124`.

---

## Default system prompts

Both system prompts are extracted as exported constants so the preferences pane (`preferenceScript.ts`) can populate its textarea with the default when the user has not set a custom one. They are pure strings with no dependencies (`:73-76`, `:102-105`).

### `DEFAULT_TAXONOMY_SYSTEM_PROMPT`

```ts
export const DEFAULT_TAXONOMY_SYSTEM_PROMPT: string; // promptBuilder.ts:77-100
```

Default Stage 1 (taxonomy proposal) system prompt.

**Value:** an array of lines joined with `"\n"` (`:77-100`). The prompt positions the model as a "research-library taxonomy architect" given a sample of academic papers, and lists **hard constraints**:

- **8 to 15 top-level areas.** (`:84`)
- **Maximum depth 3** — top-level area / child / grandchild; explicitly "Do NOT go deeper." (`:85`)
- **Concise, research-domain-oriented names** — e.g. `'SemanticComm'`, `'ChannelCoding'`, `'ResourceAlloc'`. Generic names like `'Other'` are forbidden. (`:86-87`)
- **Each collection PATH must be unique.** Two collections may share a leaf name only if their parent paths differ (the prompt's example is `'Wireless/MACProtocols'` vs `'Wired/MACProtocols'`). (`:88-90`)
- **Avoid reusing an existing top-level collection's name as a leaf under a different parent.** The prompt explicitly notes this is a *hint only* — "the authoritative guard lives in the applier." This is a deliberate layering decision: the prompt nudges the model toward non-colliding names, but the real correctness guarantee is enforced downstream in `planApplier.ts`, because the model cannot see the user's existing collections. (`:91-95`)
- **Every paper in the sample must plausibly fit somewhere in the tree.** (`:96`)
- **Each node's `path` MUST equal `parent.path + '/' + node.name`**, with the root's `path` equal to its name (no leading slash). This is the invariant the applier relies on to reconstruct the tree from flat paths. (`:97-98`)
- The final line appends `TAXONOMY_SCHEMA_INSTRUCTION` so the JSON shape is in-context. (`:99`)

### `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT`

```ts
export const DEFAULT_CLASSIFICATION_SYSTEM_PROMPT: string; // promptBuilder.ts:106-125
```

Default Stage 2 (per-item classification) system prompt.

**Value:** an array of lines joined with `"\n"` (`:106-125`). The model is positioned as a "research-library classifier" given a fixed taxonomy (as a list of slash-delimited paths) and a batch of papers. It must assign each paper to **between 1 and 3 paths** from the taxonomy, using the most specific path that fits; if nothing fits, it assigns to the closest top-level area with `confidence: 'low'`.

Hard constraints:

- **Every path in `collectionPaths` MUST appear verbatim in the provided taxonomy path list.** No inventing new paths. (`:115-116`)
- **Use the FULL slash-delimited path** (e.g. `'SemanticComm/JSCC/Analog'`), not just the leaf. The prompt reiterates the same leaf-name-collision caveat as the taxonomy prompt. (`:117-119`)
- **One assignment object per item**, with the matching `itemId`. (`:120-121`)
- **Confidence semantics**: `'high'` only when the paper clearly belongs; `'medium'` for reasonable-but-less-certain; `'low'` for guesses or no fit. (`:122-123`)
- Final line appends `CLASSIFICATION_SCHEMA_INSTRUCTION`. (`:124`)

---

## Functions

### serializeItemForPrompt

Serialize a single `LibraryItem` into the compact, one-line-per-field form used by **both** Stage 1 and Stage 2 prompts. Pure; missing fields become empty strings; never throws.

```ts
export function serializeItemForPrompt(item: LibraryItem): string  // promptBuilder.ts:143
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item` | `LibraryItem` | Yes | The library item to serialize. |

**Returns:** `string` — the compact one-line-per-field serialization (e.g. `itemId: ...\ntitle: ...\nvenue: ...\ndate: ...\ncurrentTopCollection: ...`).

**Throws:** None.

### Internal logic

1. **Top collection extraction** (`:144-147`): takes `item.collectionPaths[0]` (the first path, if any) and splits on `"/"`, keeping only the top-level segment. If the item has no collection paths, the value is the literal string `"(unfiled)"`. This collapses the multi-path, slash-delimited `collectionPaths` array down to a single coarse signal — "where does this paper currently live at the top level?" — which is all the taxonomy stage needs.
2. **Creator formatting** (`:148-151`): maps each creator to `"lastName, firstName"` (filtering out falsy parts), then joins multiple creators with `"; "`. The `creatorType` field on `LibraryItem` is intentionally dropped — the prompt does not distinguish authors from editors.
3. **Field lines** (`:152-158`): always emits, in this fixed order:
   - `itemId: <item.id>`
   - `title: <truncate(title, 200)>`
   - `venue: <truncate(publicationTitle, 80)>`
   - `date: <truncate(date, 10)>`
   - `currentTopCollection: <topCollection>`
4. **Conditional abstract line** (`:159-161`): only emitted when `ABSTRACT_BUDGET_CHARS > 0`. With the current default of `0`, the abstract is omitted entirely.

The fixed field order and `key: value` shape make the prompt trivially greppable and stable across runs — important because the orchestrator and tests both parse the serialized form by string matching.

### truncate

Internal helper. Collapses all internal whitespace to single spaces, trims, and if the result exceeds `max` characters, slices to `max - 1` and appends the ellipsis character `"…"` (after a `trimEnd()`). The `?? ""` guard means `null`/`undefined` inputs become `""` rather than throwing. The off-by-one (`max - 1`) accounts for the ellipsis so the final string is at most exactly `max` characters.

```ts
function truncate(text: string, max: number): string  // promptBuilder.ts:131
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `text` | `string` | Yes | The text to truncate. `null`/`undefined` are coerced to `""`. |
| `max` | `number` | Yes | Maximum length of the returned string, including the trailing `"…"` when truncation occurs. |

**Returns:** `string` — whitespace-collapsed, trimmed, and truncated to `max` characters.

**Throws:** None.

---

## `buildTaxonomyPrompt`

### buildTaxonomyPrompt

Builds the Stage 1 (taxonomy proposal) message pair.

```ts
export function buildTaxonomyPrompt(
  sample: LibraryItem[],
  customSystemPrompt?: string,
): { system: string; user: string }  // promptBuilder.ts:171
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sample` | `LibraryItem[]` | Yes | The sample of library items to serialize into the user message. The orchestrator is responsible for capping this at `TAXONOMY_SAMPLE_LIMIT`. |
| `customSystemPrompt` | `string` | No | Optional custom system prompt. A non-empty *trimmed* string replaces the default; `undefined`, empty string, or all-whitespace falls back to `DEFAULT_TAXONOMY_SYSTEM_PROMPT`. |

**Returns:** `{ system: string; user: string }` — the Stage 1 message pair ready for `chatComplete()`.

**Throws:** None.

### Custom system prompt override

```ts
const system =
  customSystemPrompt && customSystemPrompt.trim().length > 0
    ? customSystemPrompt
    : DEFAULT_TAXONOMY_SYSTEM_PROMPT;  // promptBuilder.ts:178-181
```

The override mechanism is intentionally narrow: a non-empty *trimmed* string wins; everything else (undefined, empty string, all-whitespace) falls back to the default. This lets the preferences pane pass `undefined` when the user cleared the textarea, without the caller having to do its own emptiness check. Note that overriding the system prompt **replaces it wholesale** — the user's custom prompt is responsible for re-stating the JSON schema and the constraints, because the schema instruction is concatenated into the *default* prompt, not appended to whatever the caller supplies.

### User message structure

The user message (`:187-194`) is a fixed scaffold:

```
Here are <N> sample papers from a research library
(primarily wireless communications and adjacent ML/SEM topics):

--- paper 1 ---
<serializeItemForPrompt(sample[0])>

--- paper 2 ---
<serializeItemForPrompt(sample[1])>
...

Propose the taxonomy. Return ONLY the JSON object described above.
```

The papers are numbered from 1 (human-readable, not zero-indexed) and separated by a blank line. The opening line hard-codes the assumption that the library is "primarily wireless communications and adjacent ML/SEM topics" — this is a domain hint baked into the prompt, not a parameter. The closing line reiterates "Return ONLY the JSON object described above," reinforcing the no-prose/no-fences rule from the system prompt.

### Purity

The function does not mutate `sample` or any item, and produces deterministic output for a given input — both required for snapshot testing.

---

## `buildClassificationPrompt`

### buildClassificationPrompt

Builds the Stage 2 (per-item classification) message pair.

```ts
export function buildClassificationPrompt(
  batch: LibraryItem[],
  taxonomyPaths: string[],
  customSystemPrompt?: string,
): { system: string; user: string }  // promptBuilder.ts:206
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `batch` | `LibraryItem[]` | Yes | The slice of items to classify in a single LLM call. The orchestrator is responsible for batching; this function classifies exactly the items it is given. |
| `taxonomyPaths` | `string[]` | Yes | Flat list of every valid path in the proposed taxonomy, as produced upstream by `flattenTaxonomyPaths` (see `taxonomyStage.ts`). Taken as opaque; no validation is performed. |
| `customSystemPrompt` | `string` | No | Optional custom system prompt. Non-empty trimmed string wins, else default (`:211-214`). Behaves identically to `buildTaxonomyPrompt`. |

**Returns:** `{ system: string; user: string }` — the Stage 2 message pair ready for `chatComplete()`.

**Throws:** None.

### User message structure

The user message (`:216-233`) has two blocks:

1. **Taxonomy block** (`:216-219`):
   ```
   Taxonomy paths (<N> total):
   - <path 1>
   - <path 2>
   ...
   ```
   Each path is prefixed with `"- "` and listed on its own line. The total count is included so the model (and a human debugging the prompt) can sanity-check coverage.

2. **Items block** (`:221-223`): identical per-item serialization as Stage 1, with `--- paper N ---` headers, blank-line separated.

The closing instruction is `"Return ONLY the JSON object described above."` (`:232`).

### Design note

The taxonomy is injected as a *flat path list* rather than as the nested tree JSON. This is deliberate: by Stage 2 the model only needs to *pick from* the taxonomy, not navigate it, and a flat bulleted list of full paths is the cheapest, least-ambiguous representation. It also aligns 1:1 with the "Every path in `collectionPaths` MUST appear verbatim" constraint — the model can string-match against the bulleted list.

---

## `buildRetryPrompt`

### buildRetryPrompt

Builds the corrective retry message pair appended after the LLM's failed response. `error` is the validator's human-readable error message (from `planValidator.ts`).

```ts
export function buildRetryPrompt(error: string): {
  system: string;
  user: string;
}  // promptBuilder.ts:247
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `error` | `string` | Yes | The validator's human-readable error message describing why the previous response was rejected. |

**Returns:** `{ system: string; user: string }` — the retry message pair to append to the existing conversation and re-send via `chatComplete()`.

**Throws:** None.

### Retry semantics

The retry is sent as a **follow-up user message in the same conversation**, not as a fresh call. The docstring (`:240-246`) spells out why: this lets the LLM retain the original system prompt, the item sample/batch, and its own previous (invalid) output, so it can fix the JSON in context rather than guessing from a bare error string.

### Message contents

The `system` field (`:251-255`) is a short re-statement:

> Your previous response could not be parsed or did not match the required JSON schema. Return ONLY the corrected JSON object, with no markdown fences and no prose.

The `user` field (`:256-263`) is:

```
Your previous response could not be used:

<error>

Re-emit the FULL corrected JSON object now. Output ONLY the JSON, no prose,
no markdown fences.
```

The final sentence — **"Re-emit the FULL corrected JSON object now. Output ONLY the JSON, no prose, no markdown fences."** — is the canonical retry wording. "FULL" is load-bearing: it tells the model to re-emit the entire JSON object (not a patch, not a diff, not just the offending node), because the validator re-parses the whole response from scratch.

### How it is consumed

The caller (`taxonomyStage.ts` / `classificationStage.ts`) is expected to push this `{system, user}` pair onto the existing message array and re-invoke `chatComplete()`. The retry pair does **not** carry the items or taxonomy again — those are already in the conversation history. This keeps the retry cheap and avoids contradicting the earlier context.

---

## Prompt constraints (summary)

The constraints enforced *via prompt text* (as opposed to validated after the fact) are:

| Constraint | Where stated | Also validated downstream? |
| --- | --- | --- |
| 8–15 top-level areas | `DEFAULT_TAXONOMY_SYSTEM_PROMPT:84` | Yes — `planValidator.ts` |
| Max depth 3 | `DEFAULT_TAXONOMY_SYSTEM_PROMPT:85` | Yes — `planValidator.ts` |
| Concise, domain-oriented names; no `'Other'` | `:86-87` | No (subjective) |
| Unique collection paths | `:88-90` | Yes — `planValidator.ts` / `planApplier.ts` |
| Don't reuse an existing top-level name as a leaf elsewhere | `:91-95` (hint only) | Yes — `planApplier.ts` (authoritative) |
| `path === parent.path + '/' + name` | `:97-98` | Yes — `planValidator.ts` |
| Strict JSON, no fences, no prose | `TAXONOMY_SCHEMA_INSTRUCTION:32` | Yes — JSON parse step |
| `collectionPaths` entries verbatim from taxonomy | `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT:115-116` | Yes — `planValidator.ts` |
| Full slash-delimited paths (not leaf-only) | `:117-119` | Yes — `planValidator.ts` |
| 1–3 paths per item | `CLASSIFICATION_SCHEMA_INSTRUCTION:67` | Yes — `planValidator.ts` |
| `itemId` matches a batch id | `CLASSIFICATION_SCHEMA_INSTRUCTION:65` | Yes — `planValidator.ts` |
| `confidence` ∈ {high, medium, low} | `CLASSIFICATION_SCHEMA_INSTRUCTION:68` | Yes — `planValidator.ts` |
| Retry: full JSON, no prose, no fences | `buildRetryPrompt:261-262` | Yes — re-parse |

The pattern is intentional: the *prompt* asks for the constraint, and the *validator* enforces it. The prompt is the model's first line of defense; the validator is the system's guarantee.

---

## Interactions with other modules

- **`libraryModel.ts`** — provides the `LibraryItem` type (`libraryModel.ts:10-23`) that every builder accepts. Type-only import; no runtime dependency.
- **`llmClient.ts`** — consumes the `{system, user}` pairs returned here via its `chatComplete()` function. The prompt builder produces the strings; the client sends them.
- **`taxonomyStage.ts`** — calls `buildTaxonomyPrompt()` for Stage 1 and `buildRetryPrompt()` on validation failure; produces the proposed taxonomy that becomes the `taxonomyPaths` input to Stage 2.
- **`classificationStage.ts`** — calls `buildClassificationPrompt()` for Stage 2, with `taxonomyPaths` produced by `flattenTaxonomyPaths` over the Stage 1 output.
- **`planValidator.ts`** — produces the `error` string fed into `buildRetryPrompt()`, and is the authoritative checker for the constraints the prompts merely request.
- **`planApplier.ts`** — owns the authoritative guard against name collisions with existing collections (the prompt's "hint only" at `:91-95` defers to this).
- **`preferenceScript.ts`** — reads `DEFAULT_TAXONOMY_SYSTEM_PROMPT` and `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` to populate the custom-prompt textareas with their defaults.

---

## Extending or modifying the prompts

- **Re-enable abstracts.** Set `ABSTRACT_BUDGET_CHARS` (`:26`) to a positive integer (e.g. `500`). The serializer's guarded branch at `:159-161` will start emitting `abstract: <truncated>` lines with no other changes. Be mindful of the 40-item sample budget against your model's context window.
- **Change the sample cap.** Update `TAXONOMY_SAMPLE_LIMIT` (`:23`) and ensure the orchestrator's sampling logic respects the new value. The constant is exported so callers can reference the same number.
- **Add a new serialized field.** Add it to the `lines` array in `serializeItemForPrompt` (`:152-158`). Keep the `key: value` shape and the deterministic ordering. If the new field is long, wrap it in `truncate(...)`.
- **Change a hard constraint.** Edit the relevant line in `DEFAULT_TAXONOMY_SYSTEM_PROMPT` or `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT`, **and** update `planValidator.ts` to match. The two must stay in sync: a constraint removed from the prompt but kept in the validator will cause retries; a constraint added to the prompt but not the validator will not be enforced.
- **Change the retry wording.** Edit the `user` array in `buildRetryPrompt` (`:256-263`). The string `"Re-emit the FULL corrected JSON object now. Output ONLY the JSON, no prose, no markdown fences."` is the canonical phrasing — if you shorten it, preserve the words **FULL** (so the model re-emits the whole object) and **ONLY the JSON** (so it does not wrap the output in fences or add commentary).
- **Override the system prompt per call.** Pass a non-empty trimmed `customSystemPrompt` to either `buildTaxonomyPrompt` or `buildClassificationPrompt`. Note that this *replaces* the default entirely — your custom prompt must re-state the JSON schema instruction (e.g. by concatenating `TAXONOMY_SCHEMA_INSTRUCTION` yourself), because the schema is appended only inside the default prompt.
