# Organizer Review Window (UI Controller)

This document covers the **review window** — the user-facing "Gate 4" surface where a generated categorization plan is presented for human review, applied to the library, and (if needed) reverted. The window is the only interactive surface of the Smart Organizer plugin; everything upstream (plan generation, snapshot, apply, revert) is headless and is driven from here.

The controller lives in `src/modules/organizerUI.ts`. The window layout is `addon/content/organizer.xhtml`, and its styles are `addon/content/organizer.css`. A small DOM helper used throughout, `src/utils/domHelpers.ts`, is essential to understanding *why* the rendering is done the way it is, so it is covered here too.

---

## Lifecycle overview

The review window moves through a fixed sequence of states. Each state corresponds to one of three mutually exclusive top-level panels in the XUL document; the controller toggles them by setting `style.display`:

```
openReviewWindow()
   │
   │  openDialog(chrome://…/organizer.xhtml)
   ▼
initOrganizerUI(win)            ← wires buttons, then calls startGenerating
   │
   ▼
startGenerating(win)            ← shows #smartorganizer-generating overlay
   │  ├─ LLM progress callback enqueues text into in-memory buffers
   │  ├─ 150ms setInterval timer flushes buffers to the DOM
   │  └─ on completion: showGenerating(false) → renderPlan(win)
   ▼
renderPlan(win)                 ← shows #smartorganizer-main (taxonomy tree + items)
   │
   │  user clicks Apply  ──►  onApply(win)
   │                            ├─ captureSnapshot() BEFORE any write
   │                            ├─ showApplying(true)  (#smartorganizer-applying)
   │                            ├─ setButtonsDisabled(true)
   │                            ├─ 150ms timer flushes apply progress
   │                            ├─ applyPlan(plan, { onProgress })
   │                            └─ showApplying(false), Revert enabled
   │
   │  user clicks Revert  ──►  onRevert(win)
   │                            ├─ Services.prompt.confirm(...)
   │                            ├─ revertFromSnapshot(state.snapshot)
   │                            └─ Revert disabled again
   │
   │  user clicks Regenerate ─► onRegenerate(win) → startGenerating(win) again
   │
   └─ Cancel ─────────────────► state.generating=false; win.close()
```

The three panels — `#smartorganizer-generating`, `#smartorganizer-applying`, `#smartorganizer-main` — are siblings in the XUL `<vbox id="smartorganizer-root">`. Only one is visible at a time; the header and footer (with the four buttons) are always visible.

---

## Module state: `OrganizerWindowState`

```ts
interface OrganizerWindowState {
  plan: CategorizationPlan | null;
  snapshot: RevertSnapshot | null;
  lastApply: ApplyResult | null;
  window: Window | null;
  selectedPath: string | null;
  progressText: string;     // live progress text for the polling timer to read
  generating: boolean;       // whether generation is in progress
}
```

`organizerUI.ts:40-50`

| Field | Type | Description |
|---|---|---|
| `plan` | `CategorizationPlan \| null` | The generated plan, or `null` until generation completes. |
| `snapshot` | `RevertSnapshot \| null` | Pre-apply snapshot, captured before any write in `onApply`. |
| `lastApply` | `ApplyResult \| null` | Result of the most recent `applyPlan` call. |
| `window` | `Window \| null` | The live chrome window handle, used to detect/reuse an open window. |
| `selectedPath` | `string \| null` | Path of the currently-selected taxonomy node. |
| `progressText` | `string` | Live progress text for the polling timer to read. |
| `generating` | `boolean` | Whether generation is in progress. |

A single module-level `state` object (`organizerUI.ts:52-60`) holds everything that must persist between the menu handler (which opens the window) and the window's `onload` (which renders it). **Only one review window is supported at a time.** If `openReviewWindow()` is called while a window is already open and not closed, it focuses the existing window and restarts generation rather than opening a second one (`organizerUI.ts:76-80`).

The state is the bridge between two otherwise-separated scopes:

- The plugin's main-Zotero scope, where `Zotero.SmartOrganizer` is defined and `generatePlan`/`applyPlan`/`captureSnapshot` are reachable.
- The chrome window scope, which is a separate JS realm and does **not** see `Zotero.SmartOrganizer` (see "onload scope issue" below).

Because the controller module is imported once and `state` is a module-level constant, both scopes end up reading the same object via the closures captured in `initOrganizerUI`.

---

### openReviewWindow

Opens the review window and starts generating a plan, or focuses an already-open window and restarts generation.

```ts
export async function openReviewWindow(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | — |

**Returns:** `Promise<void>` — resolves once the dialog has loaded and `initOrganizerUI(win)` has been invoked (or immediately if an existing window was reused).

**Throws:** None directly; rejections from `startGenerating` on the reused-window path are floated as unhandled rejections (wrapped in `void`).

`organizerUI.ts:69-107`

Entry point. Called from the "Smart Organizer: Organize Library" menu item. Responsibilities:

1. **Reset state** for a fresh generation — `plan`, `snapshot`, `lastApply` are cleared (`organizerUI.ts:71-73`). Note that `state.window` is *not* cleared here; it is overwritten below.
2. **Reuse an open window.** If `state.window` is live (`!state.window.closed`), focus it and call `startGenerating(state.window)` again, then return (`organizerUI.ts:76-80`).
3. **Open the dialog via `chrome://`**, not `file://`. The URL is built as `chrome://${config.addonRef}/content/organizer.xhtml` (`organizerUI.ts:84`). The `chrome://` protocol is registered in `bootstrap.js` and is the only URL scheme the chrome window will load from; a `file://` URL built from `rootURI` would be rejected by the chrome registry.
4. **Wait for the window to load.** A `Promise<void>` resolves either immediately if `win.document.readyState === "complete"` or on the window's `load` event (`organizerUI.ts:97-103`).
5. **Initialize from the plugin context.** `initOrganizerUI(win)` is called from *this* scope, not from the window's `onload` attribute (see "onload scope issue").

```ts
const win = mainWin.openDialog(
  reviewUrl,
  "smartorganizer-review",
  "chrome,dialog=no,centerscreen,resizable=yes,width=900,height=640",
) as unknown as Window;
```

The window features string is the standard Zotero dialog recipe: `chrome` (use native chrome, not browser chrome), `dialog=no` (resizable window, not a modal dialog), `centerscreen`, and a starting size of 900×640.

---

### initOrganizerUI

Initializes the review window after its XHTML loads: stores the window handle, wires up the four footer buttons, and either renders an existing plan or starts generating.

```ts
export function initOrganizerUI(win: Window): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The chrome window to initialize. |

**Returns:** `void`.

**Throws:** None; `startGenerating` failures on the fresh-generation path are caught and routed to `Zotero.debug`.

`organizerUI.ts:294-324`

Called after the window has loaded. It:

1. Stores `win` into `state.window` (so `openReviewWindow` can reuse it next time).
2. **Wires up the four footer buttons** with a small `wireBtn` helper that registers both `command` (XUL standard) and `click` (HTML fallback) listeners (`organizerUI.ts:299-303`). The double-binding is defensive: `<button>` in this document is a XUL button and fires `command`, but mixing HTML elements into a XUL document makes `click` a useful fallback. Both listeners fire on a XUL button — handlers must therefore be idempotent. The handlers themselves are wrapped in `void …` so a rejected promise becomes an unhandled rejection log rather than crashing the click handler.
3. Decides whether to render an existing plan or start generating:
   - If `state.plan` already exists (window reopened), hides the generating overlay and calls `renderPlan(win)`.
   - Otherwise calls `startGenerating(win).catch(…)` (`organizerUI.ts:320-322`).

Button wiring:

```ts
wireBtn("smartorganizer-apply",     () => void onApply(win));
wireBtn("smartorganizer-revert",    () => void onRevert(win));
wireBtn("smartorganizer-regenerate",() => void onRegenerate(win));
wireBtn("smartorganizer-cancel",    () => {
  state.generating = false;
  try { win.close(); } catch (e) { Zotero.debug(`…win.close() failed: ${e}`); }
});
```

`Cancel` is the only button that touches `state.generating` from outside the timer — it lets the polling loop in `startGenerating` stop itself on its next tick rather than tearing the timer down from the outside.

---

### startGenerating

Shows the "generating" overlay and runs the LLM plan generation, keeping a live activity log, reasoning trace, and progress bar visible via a 150ms timer-flush pattern.

```ts
async function startGenerating(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The review window to drive the overlay and timers in. |

**Returns:** `Promise<void>` — resolves after the plan is generated and the panel has swapped to the plan view, or after an error has been surfaced to the generating overlay.

**Throws:** None thrown outward; `generatePlan` errors are caught, logged, and shown in `#smartorganizer-gen-message` (red text), with the generating overlay left visible.

`organizerUI.ts:118-228`

This is the most intricate function in the module. It runs the LLM plan generation while keeping a live activity log, reasoning trace, and progress bar visible. The hard problem it solves: **XUL elements do not repaint during a long synchronous-ish `await` loop**, so any DOM write done inside the `generatePlan` progress callback would never appear until the loop yielded back to the event loop — by which time the operation might be finished.

#### The 150ms timer flush pattern

The solution is to split the work into two paths:

- **Producer path** — the `generatePlan` progress callback (`organizerUI.ts:169-192`) only mutates in-memory string/number locals (`logText`, `reasoningText`, `lastMessage`, `lastProgress`). It never touches the DOM.
- **Consumer path** — a `win.setInterval(…, 150)` timer (`organizerUI.ts:141-163`) reads those locals and writes them to the DOM in one batch per tick.

```ts
const timer = win.setInterval(() => {
  if (logEl && logText.length > 0) {
    logEl.value = logText;
    try { logEl.scrollTop = logEl.scrollHeight; } catch {}
  }
  if (reasoningEl && reasoningText.length > 0) {
    reasoningEl.value = reasoningText;
    try { reasoningEl.scrollTop = reasoningEl.scrollHeight; } catch {}
  }
  const msgEl = doc.getElementById("smartorganizer-gen-message") as any;
  if (msgEl) msgEl.setAttribute("value", lastMessage);
  const barEl = doc.getElementById("smartorganizer-gen-bar") as any;
  if (barEl) barEl.setAttribute("value", String(lastProgress));

  // When generation is done, stop the timer and swap to plan view.
  if (!state.generating) {
    win.clearInterval(timer);
    if (state.plan) {
      showGenerating(doc, false);
      renderPlan(win);
    }
  }
}, 150);
```

Notes:

- The interval is **150ms** (`organizerUI.ts:163`), not 500ms — the JSDoc above the function says 500ms but the actual code uses 150. Treat 150 as authoritative.
- The textarea is rewritten wholesale each tick (`logEl.value = logText`), not appended to. Appending line-by-line is much slower and can starve the main thread on large logs.
- `scrollTop = scrollHeight` auto-scrolls to the bottom; the `try/catch` swallows the rare case where the element has been removed (e.g. user closed the window mid-generation).
- The timer is also the **completion signal**: when `state.generating` flips to `false`, the next tick clears the timer and swaps to `renderPlan`. This means the swap is at most 150ms behind the actual completion — cheap and race-free.

#### The progress callback

`generatePlan` accepts a single `(update) => void` callback. Each `update` has a `stage` field that distinguishes **reasoning** chunks from **progress/status** lines (`organizerUI.ts:172-186`):

| `update.stage` | Handling | Target |
|---|---|---|
| `"reasoning"` | Append `update.detail ?? update.message` to `reasoningText` (no timestamp, no newline) | `#smartorganizer-gen-reasoning` |
| anything else | Append `[${ts}] ${message}` and each `\n`-separated line of `detail` to `logText` | `#smartorganizer-gen-log` |

Both stages also extract `update.current`/`update.total` into `lastProgress` (`organizerUI.ts:189-191`) so the timer can update `#smartorganizer-gen-bar` (a XUL `<progressmeter mode="determined">` whose `value` is a 0–100 integer).

#### Error handling

If `generatePlan` throws, the timer is cleared, `state.generating` is set to `false`, and `#smartorganizer-gen-message` is set to `Error: ${msg}` with red text (`organizerUI.ts:193-205`). The generating overlay is **left visible** so the user sees the error and the partial log; the panel is not swapped to `renderPlan` (there is no plan to render).

#### Completion

On success (`organizerUI.ts:208-227`):

1. `state.generating = false`.
2. The timer is cleared (the timer-driven swap would also work, but the code clears it explicitly and does a final flush to be safe).
3. `state.plan = plan`.
4. `showGenerating(doc, false)` hides the generating overlay.
5. `renderPlan(win)` shows the plan view.

`generatePlanSummary(plan)` is dumped to `Zotero.debug` for diagnostic purposes (`organizerUI.ts:221-223`).

---

### showGenerating

Toggles the generating overlay versus the plan view by setting `style.display` on the two top-level panels.

```ts
function showGenerating(doc: Document, generating: boolean): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `doc` | `Document` | Yes | The window document containing the panels. |
| `generating` | `boolean` | Yes | `true` to show the generating overlay; `false` to show the plan view. |

**Returns:** `void`.

**Throws:** None.

`organizerUI.ts:233-241`

Toggles the generating overlay. Two elements are touched:

- `#smartorganizer-generating` (a XUL `<vbox>`) — shown when `generating === true`.
- `#smartorganizer-main` (an **`html:div`**) — shown when `generating === false`, using `display: "block"`.

The comment at `organizerUI.ts:237-240` records a previous bug: when `#smartorganizer-main` was a XUL `<hbox>`, the correct show value was `"-moz-box"`. After the panel was rewritten as an `html:div` (see "Why pure HTML divs" below), the XUL display value stopped working and had to be changed to `"block"`. This is one of the XUL→HTML migration traps that motivated the design.

---

### showApplying

Toggles the applying overlay against the plan view; the apply-phase analogue of `showGenerating`.

```ts
function showApplying(win: Window, applying: boolean): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window whose applying/main panels should be toggled. |
| `applying` | `boolean` | Yes | `true` to show the applying overlay and hide the plan; `false` to reverse. |

**Returns:** `void`.

**Throws:** None.

`organizerUI.ts:249-274`

`showApplying` is the apply-phase analogue of `showGenerating`: it hides `#smartorganizer-main` and shows `#smartorganizer-applying` (or vice versa). The applying overlay contains a `<progressmeter id="smartorganizer-apply-bar">`, a `<description id="smartorganizer-apply-message">`, and a smaller `<description id="smartorganizer-apply-detail">`.

---

### setApplyProgress

Writes one snapshot of the applying overlay's three progress fields (message, percent, detail). Called by the 150ms timer inside `onApply`.

```ts
function setApplyProgress(
  win: Window,
  message: string,
  percent: number,
  detail: string,
): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window whose applying overlay should be updated. |
| `message` | `string` | Yes | Status line shown in `#smartorganizer-apply-message`. |
| `percent` | `number` | Yes | Integer 0–100 written to `#smartorganizer-apply-bar`. |
| `detail` | `string` | Yes | Smaller detail text written to `#smartorganizer-apply-detail`. |

**Returns:** `void`.

**Throws:** None.

`organizerUI.ts:249-274`

`setApplyProgress` writes one snapshot of those three values. It is called by the 150ms timer inside `onApply` — the **same flush pattern** as `startGenerating`, just with three fields instead of four. There is no separate "producer" callback object; the producer is the `onProgress` argument passed to `applyPlan`, which closes over the same `applyMsg`/`applyPct`/`applyDetail` locals.

---

### setButtonsDisabled

Disables (or re-enables) the Apply and Regenerate buttons to prevent re-entrancy during an apply.

```ts
function setButtonsDisabled(win: Window, disabled: boolean): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window whose buttons should be toggled. |
| `disabled` | `boolean` | Yes | `true` to disable Apply + Regenerate; `false` to re-enable. |

**Returns:** `void`.

**Throws:** None.

`organizerUI.ts:282-288`

Disables `#smartorganizer-apply` and `#smartorganizer-regenerate` during an apply. **Revert and Cancel are intentionally left alone**:

- `Revert` is disabled/enabled separately based on `state.snapshot` existence (`renderPlan`, `organizerUI.ts:391-394`).
- `Cancel` stays enabled so the user can always close the window, even mid-apply.

This is the "button disable-during-apply" pattern: the apply is a non-trivial write operation that can take seconds to minutes on a large library; without disabling, a user double-clicking Apply could enqueue a second `applyPlan` call against a half-applied library. The Revert button is *not* disabled during apply because Revert is already gated on `state.snapshot`, which only exists *after* `applyPlan` returns — so a mid-apply click on Revert would no-op (snapshot still `null`).

---

### renderPlan

Renders the current `state.plan` into the main panel: header stats, taxonomy tree, and a reset item list, and refreshes the Revert button's disabled state.

```ts
function renderPlan(win: Window): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window to render the plan into. |

**Returns:** `void`.

**Throws:** None; if `state.plan` is null it calls `setStatus(win, "No plan loaded.", "error")` and returns.

`organizerUI.ts:333-395`

Renders the current `state.plan` into the main panel. Steps:

1. **Header stats.** `#smartorganizer-stats` is an `html:div`, so its text is set via `textContent` (not `.value` — that was the old XUL `<label>` pattern and does not work on HTML divs; see `organizerUI.ts:341-352`). The line shows item counts, collection counts, top-level collection count, and the model name:
   ```
   Items: 312 | Assigned: 298 | Unfiled: 14 | Collections: 27 (5 top) | Model: gpt-4o-mini
   ```

2. **Path → count map.** A `Map<string, number>` is built by iterating every assignment and every `collectionPath` on each assignment (`organizerUI.ts:355-360`). This is what powers the `(count)` annotation on each tree node.

3. **Tree rendering.** `#smartorganizer-tree` is cleared (`textContent = ""`) and one `renderNode` per top-level taxonomy node is appended (`organizerUI.ts:367-374`). An explicit `style.height = "520px"` is set as a fallback — the comment at `organizerUI.ts:362-366` explains that the surrounding flex column would also give it height via `flex: 1`, but the explicit pixel height is kept as a belt-and-suspenders measure against XUL/CSS flex interaction bugs.

4. **Item list reset.** `#smartorganizer-items` is cleared and an italic placeholder ("Select a collection node to see its items.") is inserted (`organizerUI.ts:377-388`).

5. **Revert button state.** `revertBtn.disabled = state.snapshot === null` — Revert is only meaningful after an apply has produced a snapshot (`organizerUI.ts:391-394`).

If `state.plan` is null (should not normally happen, but is checked defensively), `setStatus(win, "No plan loaded.", "error")` is called and the function returns.

---

### renderNode

Renders one taxonomy node as a clickable label line plus its recursively-rendered children, returning the container element.

```ts
function renderNode(
  node: TaxonomyNode,
  counts: Map<string, number>,
  win: Window,
): Element
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `node` | `TaxonomyNode` | Yes | The taxonomy node to render. |
| `counts` | `Map<string, number>` | Yes | Path → item-count map built by `renderPlan`. |
| `win` | `Window` | Yes | The window to create elements and wire clicks in. |

**Returns:** `Element` — the container `<div>` holding the label and all child subtrees, for the caller to `appendChild`.

**Throws:** None.

`organizerUI.ts:406-437`

Renders **one** taxonomy node as a clickable label line plus its recursively-rendered children. The function is the canonical example of the "pure HTML divs inside a XUL window" pattern.

```ts
const container = el(doc, "div", `margin-left: ${indent}px;`);

const descPart = node.description ? ` — ${node.description}` : "";
const label = el(
  doc,
  "div",
  `cursor: pointer; padding: 2px 4px; font-weight: ${
    node.path.includes("/") ? "normal" : "bold"
  };`,
  `${node.name} (${count})${descPart}`,
);
label.addEventListener("click", () => {
  selectNode(node.path, win);
});
container.appendChild(label);

for (const child of node.children) {
  container.appendChild(renderNode(child, counts, win));
}
return container;
```

Key points:

- **Indentation by path depth.** `indent = (node.path.split("/").length - 1) * 16` (`organizerUI.ts:413`). Top-level nodes (no `/`) get indent 0 and bold text; deeper nodes get 16px per level and normal weight.
- **All elements are HTML-namespace `<div>`s** created via the `el` helper (`domHelpers.ts:32-42`), which uses `doc.createElementNS(HTML_NS, tag)` and sets `.textContent`. This is the choice that the doc comment at `organizerUI.ts:397-405` explains in detail: a `doc.createElement("vbox")` would *also* produce an HTML-namespace element (the default namespace of the document is XUL, but `createElement` ignores namespaces and always creates an HTML-namespaced element in a XUL document). Rather than fight this, the code commits to HTML elements consistently and uses inline styles for indentation.
- **Click handler** calls `selectNode(node.path, win)` — selection is path-based, not node-reference-based, so it survives a re-render.
- The `(count)` suffix comes from the `counts` map built in `renderPlan`.

The function returns the container `Element` so the caller can `appendChild` it. Children are appended after the label, so the visual order is parent label, then each child subtree, depth-first.

---

### selectNode

Selects a taxonomy node by path and renders its directly-assigned items in the side panel with color-coded confidence badges.

```ts
function selectNode(path: string, win: Window): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | `string` | Yes | The taxonomy path of the node to select. |
| `win` | `Window` | Yes | The window to render the item list into. |

**Returns:** `void`.

**Throws:** None; silently returns if `state.plan` is null or no matching node is found.

`organizerUI.ts:442-503`

Called when a tree node is clicked. Steps:

1. `state.selectedPath = path`.
2. **Flatten the taxonomy** via `flattenNodes(plan.taxonomy)` and find the node whose `path` matches. The flatten is needed because the tree is a forest, not a single root, and a path could in principle match multiple nodes — `find` returns the first.
3. Clear `#smartorganizer-items`.
4. Filter `plan.assignments` to those whose `collectionPaths` array includes `path` (`organizerUI.ts:457-459`). Note this is **direct membership**, not subtree membership — clicking a parent does not show items assigned to its children.
5. If empty, show an italic placeholder. Otherwise, for each assignment, render a row:

```ts
const row = el(doc, "div",
  "display: flex; align-items: center; padding: 3px 4px; border-bottom: 1px solid #eee;");
const title = el(doc, "div", "flex: 1; font-size: 12px;",
  a.title || `(itemId ${a.itemId})`);
row.appendChild(title);
const badge = el(doc, "div",
  `font-size: 10px; padding: 0 6px; text-transform: uppercase; …`,
  a.confidence);
row.appendChild(badge);
itemsEl.appendChild(row);
```

The **confidence badge** is color-coded (`organizerUI.ts:487-498`):

| `a.confidence` | Text color | Background |
|---|---|---|
| `"high"`   | `#060` | `#cfc` (light green) |
| `"medium"` | `#660` | `#fec` (light yellow) |
| `"low"`    | `#600` | `#fcc` (light red) |

If `a.title` is falsy, the row falls back to `(itemId N)` so the user can still identify the item.

---

### flattenNodes

Flattens a taxonomy forest into a flat list of nodes, depth-first, using an explicit stack.

```ts
function flattenNodes(roots: TaxonomyNode[]): TaxonomyNode[]
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `roots` | `TaxonomyNode[]` | Yes | The top-level taxonomy nodes to flatten. |

**Returns:** `TaxonomyNode[]` — all nodes in the forest, depth-first order.

**Throws:** None.

`organizerUI.ts:508-519`

Depth-first iterative flatten using an explicit stack (with children pushed in reverse so they pop in source order). Used by `selectNode` for path lookup. Iterative rather than recursive to avoid stack overflow on deep taxonomies, though in practice the trees are shallow.

---

### onApply

Applies the current plan with a safety-ordered flow: capture a snapshot first, then run `applyPlan` with a phase-weighted progress overlay, and enable Revert on success.

```ts
async function onApply(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window whose overlay/buttons/status to drive. |

**Returns:** `Promise<void>` — resolves after success or error handling (no value).

**Throws:** None thrown outward; `captureSnapshot` and `applyPlan` errors are caught and surfaced via `setStatus`.

`organizerUI.ts:529-637`

The apply handler. The order of operations is critical and **safety-ordered**:

1. **Bail if no plan.** `state.plan` must be non-null (`organizerUI.ts:531-536`).
2. **Capture the snapshot FIRST, before any write** (`organizerUI.ts:538-552`). `state.snapshot = await captureSnapshot()`. If the snapshot throws, the apply is aborted and an error status is shown — **no write happens without a snapshot to revert to**. This is the cornerstone of the revert safety guarantee and is enforced here at the UI layer (the underlying `applyPlan` does not check).
3. **Show the applying overlay** and reset the progress bar to 0 (`organizerUI.ts:555-556`).
4. **Disable Apply + Regenerate** (`organizerUI.ts:559`) to prevent re-entrancy.
5. **Start a 150ms flush timer** identical in shape to the one in `startGenerating` (`organizerUI.ts:567-569`).
6. **Call `applyPlan`** with `replaceExisting: true` and an `onProgress` callback that maps the three apply phases to overall progress (`organizerUI.ts:576-593`):

   | Phase         | Progress range | Computation |
   |---|---|---|
   | `collections` | 0–10%  | `round(current / total * 10)` |
   | `refiling`    | 10–95% | `10 + round(current / total * 85)` |
   | `cleanup`     | 95%    | fixed at 95 (the final 95→100 jump happens on completion) |

   The phase-weighted mapping reflects the relative cost of each phase: refiling is by far the longest (one DB transaction per item), so it gets the lion's share of the bar.

7. **On throw:** clear the timer, hide the overlay, re-enable the buttons, show an error status, return (`organizerUI.ts:599-610`). The snapshot is *not* cleared in this case — it was captured, so the user could in principle still revert, though there is nothing to revert yet.
8. **On success:** store `result` in `state.lastApply`, clear the timer, force a final 100% flush, hide the overlay, re-enable the buttons, and set a status line summarizing the result (`organizerUI.ts:611-632`):

   ```
   Applied: 27 collections created, 298 items refiled, 3 empty collections deleted | 0 errors.
   ```

   The error count is appended only when non-zero; the "empty collections deleted" line is appended only when at least one was deleted.
9. **Enable Revert** (`organizerUI.ts:635-636`) — the snapshot now exists, so Revert is meaningful.

The debug log lines at `organizerUI.ts:530`, `:540`, `:552`, `:573-575`, `:594-598`, `:603` are verbose by design — apply is the riskiest operation and the log is the only forensic record if something goes wrong.

---

### onRevert

Reverts the library to its pre-apply state from the captured snapshot, after user confirmation.

```ts
async function onRevert(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window to show status in and disable the Revert button on success. |

**Returns:** `Promise<void>` — resolves after success or error handling (no value).

**Throws:** None thrown outward; `revertFromSnapshot` errors are caught and surfaced via `setStatus`, leaving `state.snapshot` intact for retry.

`organizerUI.ts:642-684`

1. Bail if `state.snapshot` is null (`organizerUI.ts:644-648`).
2. **Confirm with the user** via `Services.prompt.confirm(win, "Smart Organizer", "Revert the library to its pre-apply state? …")` (`organizerUI.ts:649-656`). The confirmation message is explicit about what revert does: restore every item's collection memberships and delete collections created by the apply (if now empty).
3. On confirm, set a busy status and call `revertFromSnapshot(state.snapshot)` (`organizerUI.ts:660`).
4. On success: set a success status, **clear `state.snapshot` and `state.lastApply`**, and disable the Revert button again (`organizerUI.ts:661-676`). Clearing the snapshot means a second click on Revert is a no-op — you cannot revert twice.
5. On throw: set an error status; the snapshot is *not* cleared, so the user can retry.

Revert does **not** show a progress overlay — it is generally fast enough that a status line is sufficient, and `revertFromSnapshot` does not currently expose a progress callback.

---

### onRegenerate

Re-runs `generatePlan` and re-renders the plan, leaving any prior snapshot/apply state untouched.

```ts
async function onRegenerate(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window to drive generation and set the success status in. |

**Returns:** `Promise<void>` — resolves after generation and re-render (no value).

**Throws:** None thrown outward; `startGenerating` errors are caught by the `.catch` wired in `initOrganizerUI`.

`organizerUI.ts:691-697`

Re-runs `generatePlan` and re-renders. Sets `state.plan = null` first so `startGenerating` runs the full pipeline, then calls `startGenerating(win)`. After it returns, if a plan was produced, sets a "Plan regenerated." success status.

Importantly, **regenerate does not touch `state.snapshot` or `state.lastApply`** — the JSDoc at `organizerUI.ts:687-690` calls this out: the user has not applied since the last regenerate, so any previous snapshot remains valid. If the user *has* applied and then regenerates, the snapshot is still valid for reverting that prior apply; regenerate does not invalidate it.

---

### setStatus

Sets the bottom-of-window `#smartorganizer-status` line, toggling color classes by `kind`, and mirrors the message to `Zotero.debug`.

```ts
function setStatus(
  win: Window,
  message: string,
  kind: "info" | "busy" | "success" | "error",
): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The window whose status element to update. |
| `message` | `string` | Yes | Status text to display. |
| `kind` | `"info" \| "busy" \| "success" \| "error"` | Yes | Status kind, controlling the CSS class (`info` clears all classes). |

**Returns:** `void`.

**Throws:** None; silently returns if the status element is missing.

`organizerUI.ts:699-713`

Sets the bottom-of-window `#smartorganizer-status` line. Uses `setAttribute("value", message)` because the element is a XUL `<description>` — `textContent` does not render reliably on single-line XUL elements (the comment at `organizerUI.ts:706-707` records this). The `kind` argument toggles CSS classes (`busy`, `success`, `error`) that `organizer.css:172-182` colors blue/green/red. `info` clears all classes.

`setStatus` also logs the message via `Zotero.debug` so the status line is recoverable from the debug output even when the XUL rendering is broken.

---

## The XUL window: `addon/content/organizer.xhtml`

The window is an XHTML document whose default namespace is XUL (`xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"`) and which also declares the HTML namespace (`xmlns:html="http://www.w3.org/1999/xhtml"`). This dual-namespace setup is what lets the document mix XUL chrome (`<window>`, `<vbox>`, `<hbox>`, `<button>`, `<progressmeter>`, `<description>`, `<label>`, `<spacer>`) with HTML content (`<html:div>`, `<html:textarea>`).

### Top-level structure

```
<window>
  <linkset> … <html:link rel="localization" …/> … </linkset>
  <vbox id="smartorganizer-root">
    <hbox id="smartorganizer-header">  title + #smartorganizer-stats
    <vbox id="smartorganizer-generating">   ← generating overlay (visible by default)
    <vbox id="smartorganizer-applying">     ← applying overlay (display:none)
    <html:div id="smartorganizer-main">     ← plan view (display:none)
    <vbox>                                  ← footer with 4 buttons
    <description id="smartorganizer-status">
```

### XUL lessons encoded in this file

1. **`html:link` inside `<linkset>`** (`organizer.xhtml:13-15`). The FTL localization link must be wrapped in a `<linkset>` element and use the `html:link` prefix; a bare `<link>` or a `<?xml-stylesheet?>` PI will not work for l10n. This is the standard Zotero 7 pattern.
2. **`chrome://` not `file://`.** The stylesheet PI at line 3 uses `href="organizer.css"` — a relative URL that resolves against the window's `chrome://` base. The window itself is opened from `chrome://${config.addonRef}/content/organizer.xhtml` (`organizerUI.ts:84`). A `file://` URL would be rejected by the chrome registry.
3. **HTML elements via `html:` prefix.** `#smartorganizer-stats`, `#smartorganizer-main`, the inner layout `<html:div>`s, the `<html:textarea>`s for the log and reasoning, and the `<html:div id="smartorganizer-tree">` / `<html:div id="smartorganizer-items">` containers are all HTML. This is deliberate: dynamic content is rendered by `el()` which creates HTML-namespace elements, so the containers must also be HTML for the children to lay out correctly.
4. **`#smartorganizer-main` uses `height: 400px` with `overflow: hidden`** (`organizer.xhtml:57`). The comment at lines 54-56 explains: an explicit pixel height is used instead of `flex` so the content area has a real height regardless of XUL/CSS flex interactions. `renderPlan` then overrides this with `520px` on the inner panes.
5. **The generating overlay is visible by default** (`organizer.xhtml:25`, no `display:none`). The applying overlay and main panel start hidden (`organizer.xhtml:44`, `:57`). This means the user sees the "Generating…" panel immediately on window open, before `initOrganizerUI` has even run — important for perceived responsiveness.

### Footer buttons

Four XUL `<button>`s (`organizer.xhtml:74-77`): `Regenerate Plan`, `Apply Plan`, `Revert` (disabled by default), `Cancel`. Their IDs are the hook points the controller wires up. `Revert` ships with `disabled="true"` so it cannot be clicked before the controller has had a chance to set its state.

---

## The stylesheet: `addon/content/organizer.css`

`organizer.css` defines a `.so-*` class system intended for the HTML elements in the window. Notable features:

- **CSS variables with fallbacks.** Every color references a Zotero theme variable (`--fill-quinary`, `--fill-secondary`, `--fill-primary`, `--accent-blue`, `--accent-green`, `--accent-yellow`, `--accent-red`) with a hardcoded fallback (`organizer.css:13, 22, 33, …`). This lets the window adapt to Zotero's light/dark themes without custom media queries.
- **Tree node styles (`.so-node`)** (`organizer.css:59-112`) target a `<details>`-based tree, with a CSS-drawn `▶` marker that rotates 90° when `[open]` (`organizer.css:77-86`). **Note:** the current `renderNode` implementation in `organizerUI.ts` does not emit `<details>` or `.so-node` classes — it emits plain `<div>`s with inline styles. The `.so-*` classes are therefore mostly **dormant** in the current implementation; they describe a richer intended design (collapsible nodes with a selected state) that the simpler inline-styled `renderNode` does not yet use. This is a known gap between the stylesheet and the renderer.
- **Confidence badges** (`.so-badge-high/medium/low`, `organizer.css:136-149`) — same color scheme as the inline-styled badges in `selectNode`. The inline styles in `organizerUI.ts:493-497` duplicate these rules rather than referencing the classes.
- **Status line** (`.so-status`, `organizer.css:165-182`) — colored by `.busy`/`.success`/`.error` classes that `setStatus` toggles (`organizerUI.ts:709-710`). The XHTML's `#smartorganizer-status` is a bare `<description>` without the `.so-status` class, so the `.so-status` rules also do not apply directly; `setStatus`'s class toggles would only take effect if the element were given the `so-status` class. In practice the status line is plain grey text and the colored error/success states may not render — a minor gap between CSS and markup.

The stylesheet should be read as a **design intent** document: it describes the visual target the markup and controller are partially aligned with. The inline-style approach in `renderNode`/`selectNode` was chosen to be robust against XUL/HTML namespace issues, at the cost of duplicating some of what `organizer.css` already expresses.

---

## Why pure HTML divs instead of XUL elements

The dominant rendering decision in this module is: **dynamic content is built with HTML-namespace `<div>`/`<span>` elements via the `el` helper, not with XUL `<vbox>`/`<hbox>`/`<label>`.** The reasoning, recorded in `domHelpers.ts:1-19` and `organizerUI.ts:397-405`, is:

1. **`doc.createElement("vbox")` does not create a XUL `<vbox>`.** In a XUL-namespaced document, `createElement` (without a namespace argument) creates an element in the **HTML** namespace. The result is an `HTMLDivElement`-like object whose tag name is `vbox`, not a XUL box. It will not lay out as a XUL box.
2. **The correct API for XUL elements is `doc.createXULElement("vbox")`.** This works but is verbose and traps you into XUL's layout model (`flex`, `orient`, `-moz-box`), which behaves differently from CSS flexbox and is the source of numerous migration bugs in Zotero 7+.
3. **For plain display text, HTML elements with `textContent` are strictly simpler.** They render text reliably, support standard CSS, and compose with the `html:div` containers already in the XHTML.
4. **`.value` vs `.textContent`.** XUL `<label>` renders text via `.value`; HTML `<div>` renders text via `.textContent`. Mixing these up is a common invisibility bug. The `el` helper commits to `textContent` and the call sites use it for display text only; `.value` is reserved for the real HTML form controls (`<html:textarea>` for the log/reasoning panels).

The cost of this choice is that `organizer.css`'s `.so-*` class system is largely bypassed by the inline styles in `renderNode`/`selectNode`. The benefit is that the rendering is robust and easy to reason about, and there is no risk of accidentally creating HTML-namespace "XUL" elements that fail to lay out.

---

## XUL lessons summary

| Lesson | Where it shows up | Source |
|---|---|---|
| `html:link` for l10n must be inside `<linkset>` | `organizer.xhtml:13-15` | Standard Zotero 7 pattern |
| Use `chrome://` URLs, not `file://`, for chrome windows and stylesheets | `organizerUI.ts:84`, `organizer.xhtml:3` | Chrome registry requirement |
| The window's `onload` runs in a separate scope that does not see `Zotero.SmartOrganizer` — initialize from the opener's scope | `organizerUI.ts:93-107` | Documented at `organizerUI.ts:93-96` |
| `doc.createElement("vbox")` makes an HTML element, not a XUL element — use `createXULElement` or, preferably, HTML elements with `textContent` | `domHelpers.ts:1-19`, `organizerUI.ts:397-405` | Zotero 7 migration guide |
| XUL `<label>` uses `.value`; HTML divs use `.textContent` — confusing the two makes text invisible | `organizerUI.ts:341-352`, `organizerUI.ts:706-707` | `domHelpers.ts:16-18` |
| XUL display value is `-moz-box`; HTML display value is `block` — wrong choice hides the panel | `organizerUI.ts:237-240` | Bug from XUL→HTML panel rewrite |
| XUL elements do not repaint during long async loops — drive DOM updates from a `setInterval` timer, not from the async callback | `organizerUI.ts:141-163`, `organizerUI.ts:567-569` | Empirical XUL behavior |

---

## Extension points

- **Add a new footer action.** Add a `<button id="smartorganizer-XXX">` to the footer `<hbox>` in `organizer.xhtml`, then add a `wireBtn("smartorganizer-XXX", () => …)` line in `initOrganizerUI`. If the action can run during apply, also add it to `setButtonsDisabled`.
- **Add a new progress phase to the apply bar.** `applyPlan`'s `onProgress` already emits a `phase` string. Add a branch to the phase-to-percent mapping in `onApply` (`organizerUI.ts:581-590`) and pick a percent range that does not overlap the existing 0–10 / 10–95 / 95–100 bands.
- **Replace the inline-styled tree with the `.so-node` design from `organizer.css`.** `renderNode` would need to emit `<details class="so-node">` with `<summary class="so-node-name">` etc., and `selectNode` would toggle a `.selected` class on the summary instead of relying on click handlers alone. The CSS is already written; only the renderer needs to change.
- **Persist state across window closes.** `state` is module-level and survives a window close (only `openReviewWindow` resets `plan`/`snapshot`/`lastApply`), so reopening the window reuses any plan that was generated before the close. To truly reset, call `openReviewWindow` (which clears them) rather than reusing the window.

---

## Module exports

| Symbol | Kind | Purpose |
|---|---|---|
| `openReviewWindow` | `async function` | Open (or focus) the review window and start generating. Menu entry point. |
| `initOrganizerUI` | `function` | Wire buttons and start generation; called after the window loads. |
| `config` | re-export | Re-exported from `package.json` for the menu/hook wiring (`organizerUI.ts:718-719`). |

Everything else (`startGenerating`, `renderPlan`, `renderNode`, `selectNode`, `onApply`, `onRevert`, `onRegenerate`, `setStatus`, `showGenerating`, `showApplying`, `setApplyProgress`, `setButtonsDisabled`, `flattenNodes`) is module-private.

---

## Cross-module dependencies

| Import | From | Used for |
|---|---|---|
| `config` | `package.json` | Building the `chrome://` URL (`organizerUI.ts:84`) |
| `generatePlan`, `generatePlanSummary` | `./categorizer` | Producing the plan and a human-readable summary (`organizerUI.ts:19`) |
| `CategorizationPlan`, `TaxonomyNode` (types) | `./categorizationTypes` | Type-only imports for the plan and tree node shapes (`organizerUI.ts:21-24`) |
| `applyPlan`, `ApplyResult` | `./planApplier` | Executing the plan (`organizerUI.ts:25-28`) |
| `captureSnapshot`, `revertFromSnapshot`, `RevertSnapshot` | `./revertSnapshot` | Snapshot-before-write and restore (`organizerUI.ts:29-33`) |
| `el`, `HTML_NS` | `../utils/domHelpers` | Creating HTML-namespace elements with `textContent` (`organizerUI.ts:20`) |

The controller is purely a UI orchestrator: it owns no business logic. Every state-changing operation is delegated to `categorizer`, `planApplier`, or `revertSnapshot`. The safety invariants (snapshot before write, `saveTx` transactions, numeric IDs, additive-by-default collection operations) are enforced by those modules, not here — the UI's only safety responsibility is the **ordering** in `onApply` (snapshot first, then apply) and the **button-disable** pattern that prevents re-entrant applies.
