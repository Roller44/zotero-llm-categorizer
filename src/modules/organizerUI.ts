/**
 * Controller for the Smart Organizer review window (Gate 4).
 *
 * `openReviewWindow()` opens the XHTML window defined in
 * `addon/content/organizer.xhtml` via the main window's `openDialog`. The
 * window's `onload` calls `hooks.onOrganizerLoad(window)`, which calls
 * `initOrganizerUI(window)` to populate the taxonomy tree and wire up the
 * Apply / Revert / Regenerate / Cancel buttons.
 *
 * The UI is intentionally minimal (no XUL tree widget): the taxonomy is
 * rendered as nested HTML `<details>` elements, the item list as a `<ul>` of
 * items assigned to the selected node. All write actions go through
 * `planApplier.applyPlan` (write path) and `revertSnapshot.*` (snapshot +
 * revert), which enforce the work-order safety rules (saveTx, numeric IDs,
 * additive by default, snapshot before write).
 */

import { config } from "../../package.json";
import { generatePlan, generatePlanSummary } from "./categorizer";
import { el } from "../utils/domHelpers";
import type {
  CategorizationPlan,
  TaxonomyNode,
} from "./categorizationTypes";
import {
  applyPlan,
  type ApplyResult,
} from "./planApplier";
import {
  captureSnapshot,
  revertFromSnapshot,
  type RevertSnapshot,
} from "./revertSnapshot";

/**
 * Persist the live plan + snapshot between the menu handler (which generates
 * the plan) and the window's onload (which renders it). A single window is
 * supported at a time; opening a second window reuses the in-memory state.
 */
interface OrganizerWindowState {
  plan: CategorizationPlan | null;
  snapshot: RevertSnapshot | null;
  lastApply: ApplyResult | null;
  window: Window | null;
  selectedPath: string | null;
  /** Live progress text for the polling timer to read. */
  progressText: string;
  /** Whether generation is in progress. */
  generating: boolean;
}

const state: OrganizerWindowState = {
  plan: null,
  snapshot: null,
  lastApply: null,
  window: null,
  selectedPath: null,
  progressText: "",
  generating: false,
};

/**
 * Open the review window and start generating a plan. The window opens
 * immediately in a "generating" state with a live LLM activity log; when the
 * plan is ready, the window swaps to the plan view (taxonomy tree + items).
 *
 * Called from the "Smart Organizer: Organize Library" menu item.
 */
export async function openReviewWindow(): Promise<void> {
  // Reset state for a fresh generation.
  state.plan = null;
  state.snapshot = null;
  state.lastApply = null;

  // If the window is already open, reuse it.
  if (state.window && !state.window.closed) {
    state.window.focus();
    void startGenerating(state.window);
    return;
  }

  const mainWin = Zotero.getMainWindow();
  // Use the chrome:// URL registered in bootstrap.js, not the file:// rootURI.
  const reviewUrl = `chrome://${config.addonRef}/content/organizer.xhtml`;
  const win = mainWin.openDialog(
    reviewUrl,
    "smartorganizer-review",
    "chrome,dialog=no,centerscreen,resizable=yes,width=900,height=640",
  ) as unknown as Window;

  state.window = win;

  // CRITICAL: The XHTML's onload="Zotero.SmartOrganizer.hooks..." does NOT work
  // because the chrome:// window runs in a different scope where the plugin's
  // Zotero.SmartOrganizer is not defined. Instead, we wait for the window to
  // load and initialize it directly from here (where we have access to Zotero).
  await new Promise<void>((resolve) => {
    if (win.document.readyState === "complete") {
      resolve();
    } else {
      win.addEventListener("load", () => resolve(), { once: true });
    }
  });

  // Now initialize the window from the plugin context.
  initOrganizerUI(win);
}

/**
 * Show the "generating" overlay and kick off the LLM plan generation.
 *
 * Progress/reasoning lines are pushed into a `pendingLines` queue by the
 * `generatePlan` progress callback and flushed to the DOM every 500ms by a
 * `setInterval` timer (XUL elements don't repaint during long async ops, so a
 * timer is needed to keep the log visible). When generation completes (or
 * errors), the timer is cleared and the panel swaps to the plan view.
 */
async function startGenerating(win: Window): Promise<void> {
  const doc = win.document;

  // Show the generating panel, hide the main plan view.
  showGenerating(doc, true);

  // Clear any previous log / reasoning content.
  const logEl = doc.getElementById("smartorganizer-gen-log") as any;
  if (logEl) logEl.value = "";
  const reasoningEl = doc.getElementById("smartorganizer-gen-reasoning") as any;
  if (reasoningEl) reasoningEl.value = "";

  state.generating = true;

  // Accumulate text in plain strings. The timer flushes these to the
  // textbox .value properties in one operation per tick — much faster
  // than appending line-by-line.
  let logText = "";
  let reasoningText = "";
  let lastMessage = "Starting…";
  let lastProgress = 0;

  // Timer: flush accumulated text to the DOM every 500ms.
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

  Zotero.debug("[SmartOrganizer] ===== Starting plan generation =====");

  let plan: CategorizationPlan;
  try {
    plan = await generatePlan((update) => {
      Zotero.debug(`[SmartOrganizer] PROGRESS: ${update.message}`);
      const ts = new Date().toLocaleTimeString();
      if (update.stage === "reasoning") {
        // Reasoning chunks: append to the in-memory buffer only.
        // The setInterval flush below is the SOLE path that touches the DOM,
        // so per-chunk DOM writes don't starve the main thread.
        reasoningText += update.detail || update.message;
      } else {
        // Progress/status: add timestamped line to the in-memory log buffer.
        logText += `[${ts}] ${update.message}\n`;
        if (update.detail) {
          for (const line of update.detail.split("\n")) {
            logText += `[${ts}] ${line}\n`;
            Zotero.debug(`[SmartOrganizer] ${line}`);
          }
        }
      }
      // Track latest status for the timer-driven flush; do NOT touch the DOM here.
      lastMessage = update.message;
      if (typeof update.current === "number" && typeof update.total === "number" && update.total > 0) {
        lastProgress = Math.round((update.current / update.total) * 100);
      }
    });
  } catch (e) {
    win.clearInterval(timer);
    state.generating = false;
    const msg = (e as Error).message ?? String(e);
    Zotero.debug(`[SmartOrganizer] ERROR: ${msg}`);
    const msgEl = doc.getElementById("smartorganizer-gen-message") as any;
    if (msgEl) {
      msgEl.setAttribute("value", `Error: ${msg}`);
      msgEl.style.color = "red";
    }
    // Keep the generating panel visible so the user sees the error.
    return;
  }

  // Stop the timer — it will do a final flush and swap to plan view.
  state.generating = false;
  // Give the timer one more tick to flush, then force the swap.
  try { win.clearInterval(timer); } catch {}
  // Final flush.
  if (logEl && logText.length > 0) logEl.value = logText;
  if (reasoningEl && reasoningText.length > 0) reasoningEl.value = reasoningText;

  Zotero.debug(
    `[SmartOrganizer] ===== Plan complete: ${plan.stats.totalCollections} collections for ${plan.stats.totalItems} items =====`,
  );

  state.plan = plan;

  for (const line of generatePlanSummary(plan).split("\n")) {
    Zotero.debug(`[SmartOrganizer] ${line}`);
  }

  // Swap from generating overlay to plan view.
  showGenerating(doc, false);
  renderPlan(win);
}

/**
 * Toggle between the generating overlay and the plan view.
 */
function showGenerating(doc: Document, generating: boolean): void {
  const genPanel = doc.getElementById("smartorganizer-generating") as any;
  const mainPanel = doc.getElementById("smartorganizer-main") as any;
  if (genPanel) genPanel.style.display = generating ? "" : "none";
  // mainPanel is now an html:div, so "block" is the correct display value.
  // (Previously "-moz-box" was used when it was a XUL hbox — that no longer
  // applies since the panel is HTML.)
  if (mainPanel) mainPanel.style.display = generating ? "none" : "block";
}

/**
 * Toggle the applying overlay. When shown, the plan view is hidden so the
 * user sees only the progress bar and status message. This prevents the user
 * from thinking the program is frozen during the (potentially long) apply
 * phase.
 */
function showApplying(win: Window, applying: boolean): void {
  const doc = win.document;
  const applyPanel = doc.getElementById("smartorganizer-applying") as any;
  const mainPanel = doc.getElementById("smartorganizer-main") as any;
  if (applyPanel) applyPanel.style.display = applying ? "" : "none";
  if (mainPanel) mainPanel.style.display = applying ? "none" : "block";
}

/**
 * Update the apply progress overlay: status message, progress bar value, and
 * optional detail text. Called by the timer in `onApply`.
 */
function setApplyProgress(
  win: Window,
  message: string,
  percent: number,
  detail: string,
): void {
  const doc = win.document;
  const msgEl = doc.getElementById("smartorganizer-apply-message") as any;
  if (msgEl) msgEl.setAttribute("value", message);
  const barEl = doc.getElementById("smartorganizer-apply-bar") as any;
  if (barEl) barEl.setAttribute("value", String(percent));
  const detailEl = doc.getElementById("smartorganizer-apply-detail") as any;
  if (detailEl) detailEl.setAttribute("value", detail);
}

/**
 * Enable or disable the action buttons (Apply, Regenerate) to prevent
 * re-entrancy during an apply. Cancel is left enabled so the user can close
 * the window. Revert's state is managed separately (disabled unless a
 * snapshot exists).
 */
function setButtonsDisabled(win: Window, disabled: boolean): void {
  const doc = win.document;
  const applyBtn = doc.getElementById("smartorganizer-apply") as any;
  if (applyBtn) applyBtn.disabled = disabled;
  const regenBtn = doc.getElementById("smartorganizer-regenerate") as any;
  if (regenBtn) regenBtn.disabled = disabled;
}

/**
 * Initialize the review window after its XHTML loads. Wires up the button
 * handlers and starts generating the plan. Called from `hooks.onOrganizerLoad`.
 */
export function initOrganizerUI(win: Window): void {
  state.window = win;
  const doc = win.document;

  // Wire up buttons — use both "command" (XUL standard) and "click" (fallback).
  const wireBtn = (id: string, handler: () => void) => {
    const btn = doc.getElementById(id);
    btn?.addEventListener("command", handler);
    btn?.addEventListener("click", handler);
  };
  wireBtn("smartorganizer-apply", () => void onApply(win));
  wireBtn("smartorganizer-revert", () => void onRevert(win));
  wireBtn("smartorganizer-regenerate", () => void onRegenerate(win));
  wireBtn("smartorganizer-cancel", () => {
    state.generating = false;
    try { win.close(); } catch (e) {
      Zotero.debug(`[SmartOrganizer] win.close() failed: ${e}`);
    }
  });

  // If a plan already exists (e.g. window reopened), render it directly.
  if (state.plan) {
    showGenerating(doc, false);
    renderPlan(win);
  } else {
    // Start generating — opens the "generating" overlay with a live log.
    void startGenerating(win).catch((e) =>
      Zotero.debug(`[SmartOrganizer] startGenerating failed: ${e}`),
    );
  }
}

// --- rendering ------------------------------------------------------------

/**
 * Render the current plan into the window: header stats, taxonomy tree, and
 * (empty) item list. Resets the Revert button's disabled state based on
 * whether a snapshot exists.
 */
function renderPlan(win: Window): void {
  const plan = state.plan;
  const doc = win.document;
  if (!plan) {
    setStatus(win, "No plan loaded.", "error");
    return;
  }

  // Header stats. The stats element is now an html:div, so use textContent
  // (HTML divs don't render text through .value the way XUL <label> did).
  const stats = doc.getElementById("smartorganizer-stats") as any;
  if (stats) {
    stats.textContent =
      `Items: ${plan.stats.totalItems} | ` +
      `Assigned: ${plan.stats.itemsWithAssignment} | ` +
      `Unfiled: ${plan.stats.itemsUnfiled} | ` +
      `Collections: ${plan.stats.totalCollections} ` +
      `(${plan.stats.topLevelCollections} top) | ` +
      `Model: ${plan.model}`;
  }

  // Build path -> item count map.
  const counts = new Map<string, number>();
  for (const a of plan.assignments) {
    for (const p of a.collectionPaths) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }

  // Render taxonomy tree. The container (#smartorganizer-tree) is an
  // html:div inside an html:div panel (see organizer.xhtml); node children
  // are also html:div (see renderNode). With the panel now pure HTML, the
  // explicit 520px height is a fallback — the surrounding flex column also
  // gives it height via `flex: 1`.
  const treeEl = doc.getElementById("smartorganizer-tree");
  if (treeEl) {
    (treeEl as any).style.height = "520px";
    treeEl.textContent = "";
    for (const root of plan.taxonomy) {
      treeEl.appendChild(renderNode(root, counts, win));
    }
  }

  // Reset item list.
  const itemsEl = doc.getElementById("smartorganizer-items");
  if (itemsEl) {
    (itemsEl as any).style.height = "520px";
    itemsEl.textContent = "";
    const empty = el(
      doc,
      "div",
      "color: #999; font-style: italic; padding: 6px 4px;",
      "Select a collection node to see its items.",
    );
    itemsEl.appendChild(empty);
  }

  // Revert button: disabled unless we have a snapshot.
  const revertBtn = doc.getElementById("smartorganizer-revert") as any;
  if (revertBtn) {
    revertBtn.disabled = state.snapshot === null;
  }
}

/**
 * Render one taxonomy node as a clickable label line.
 *
 * Uses an HTML-namespace `<div>` for the label text (via the `el` helper) so
 * the text renders reliably in the XUL window. The container is also an
 * HTML-namespace `<div>` to keep layout predictable; XUL `<vbox>` created via
 * `doc.createElement("vbox")` would be an HTML-namespace element anyway, so we
 * use HTML elements consistently and rely on inline styles for indentation.
 */
function renderNode(
  node: TaxonomyNode,
  counts: Map<string, number>,
  win: Window,
): Element {
  const doc = win.document;
  const count = counts.get(node.path) ?? 0;
  const indent = (node.path.split("/").length - 1) * 16;

  const container = el(doc, "div", `margin-left: ${indent}px;`);

  // Clickable label line: "Name (count) — description"
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

  // Render children.
  for (const child of node.children) {
    container.appendChild(renderNode(child, counts, win));
  }
  return container;
}

/**
 * Select a taxonomy node by path: show its assigned items in the side panel.
 */
function selectNode(path: string, win: Window): void {
  state.selectedPath = path;
  const doc = win.document;

  const plan = state.plan;
  if (!plan) return;
  const allNodes = flattenNodes(plan.taxonomy);
  const matched = allNodes.find((n) => n.path === path);
  if (!matched) return;

  // Render items for this path using XUL elements.
  const itemsEl = doc.getElementById("smartorganizer-items");
  if (!itemsEl) return;
  itemsEl.textContent = "";

  const assigned = plan.assignments.filter(
    (a) => a.collectionPaths.includes(path),
  );

  if (assigned.length === 0) {
    const empty = el(
      doc,
      "div",
      "color: #999; font-style: italic; padding: 6px 4px;",
      "No items assigned to this collection.",
    );
    itemsEl.appendChild(empty);
    return;
  }

  for (const a of assigned) {
    const row = el(
      doc,
      "div",
      "display: flex; align-items: center; padding: 3px 4px; border-bottom: 1px solid #eee;",
    );

    const title = el(
      doc,
      "div",
      "flex: 1; font-size: 12px;",
      a.title || `(itemId ${a.itemId})`,
    );
    row.appendChild(title);

    const badgeColor =
      a.confidence === "high" ? "#060" :
      a.confidence === "medium" ? "#660" : "#600";
    const badgeBg =
      a.confidence === "high" ? "#cfc" :
      a.confidence === "medium" ? "#fec" : "#fcc";
    const badge = el(
      doc,
      "div",
      `font-size: 10px; padding: 0 6px; text-transform: uppercase; color: ${badgeColor}; background-color: ${badgeBg}; border-radius: 8px;`,
      a.confidence,
    );
    row.appendChild(badge);

    itemsEl.appendChild(row);
  }
}

/**
 * Flatten a taxonomy tree into a flat list of nodes (depth-first).
 */
function flattenNodes(roots: TaxonomyNode[]): TaxonomyNode[] {
  const out: TaxonomyNode[] = [];
  const stack: TaxonomyNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) {
      stack.push(n.children[i]);
    }
  }
  return out;
}

// --- button handlers ------------------------------------------------------

/**
 * Apply the plan: capture a snapshot FIRST (before any write), then call
 * `applyPlan`. Shows a progress overlay with a live progress bar and status
 * message so the user can see the apply is running and isn't frozen. Enables
 * the Revert button on success.
 */
async function onApply(win: Window): Promise<void> {
  Zotero.debug("[SmartOrganizer] onApply: entry");
  const plan = state.plan;
  if (!plan) {
    Zotero.debug("[SmartOrganizer] onApply: no plan; aborting");
    setStatus(win, "No plan to apply.", "error");
    return;
  }

  // SAFETY: capture snapshot BEFORE any write.
  setStatus(win, "Capturing pre-apply snapshot…", "busy");
  Zotero.debug("[SmartOrganizer] onApply: capturing pre-apply snapshot");
  try {
    state.snapshot = await captureSnapshot();
  } catch (e) {
    Zotero.debug(`[SmartOrganizer] onApply: snapshot FAILED: ${e}`);
    setStatus(
      win,
      `Snapshot failed: ${(e as Error).message ?? String(e)}`,
      "error",
    );
    return;
  }
  Zotero.debug("[SmartOrganizer] onApply: snapshot captured");

  // Show the applying overlay with a progress bar.
  showApplying(win, true);
  setApplyProgress(win, "Starting apply…", 0, "");

  // Disable the action buttons during apply to prevent re-entrancy.
  setButtonsDisabled(win, true);

  // Accumulate progress in plain variables; a timer flushes to the DOM every
  // 150ms so the UI updates without starving the async apply loop.
  let applyMsg = "Starting apply…";
  let applyPct = 0;
  let applyDetail = "";

  const timer = win.setInterval(() => {
    setApplyProgress(win, applyMsg, applyPct, applyDetail);
  }, 150);

  let result: ApplyResult;
  try {
    Zotero.debug(
      `[SmartOrganizer] onApply: calling applyPlan (replaceExisting=true)`,
    );
    result = await applyPlan(plan, {
      replaceExisting: true,
      onProgress: (u) => {
        // Map the three phases to overall progress: collections 0-10%,
        // refiling 10-95%, cleanup 95-100%.
        if (u.phase === "collections") {
          applyPct = Math.round((u.current / Math.max(u.total, 1)) * 10);
          applyMsg = u.message;
        } else if (u.phase === "refiling") {
          applyPct = 10 + Math.round((u.current / Math.max(u.total, 1)) * 85);
          applyMsg = u.message;
        } else {
          applyPct = 95;
          applyMsg = u.message;
        }
        applyDetail = "";
      },
    });
    Zotero.debug(
      `[SmartOrganizer] onApply: applyPlan returned — ${result.collectionsCreated} created, ` +
        `${result.itemsRefiled} refiled, ${result.collectionsDeleted} deleted, ` +
        `${result.errors.length} errors, ${result.nameCollisions.length} collisions`,
    );
  } catch (e) {
    win.clearInterval(timer);
    showApplying(win, false);
    setButtonsDisabled(win, false);
    Zotero.debug(`[SmartOrganizer] onApply: applyPlan threw: ${e}`);
    setStatus(
      win,
      `Apply failed: ${(e as Error).message ?? String(e)}`,
      "error",
    );
    return;
  }
  state.lastApply = result;

  // Final flush, then hide the overlay.
  win.clearInterval(timer);
  setApplyProgress(win, "Apply complete!", 100, "");
  showApplying(win, false);
  setButtonsDisabled(win, false);

  const errLine =
    result.errors.length > 0
      ? ` | ${result.errors.length} errors`
      : "";
  const delLine =
    result.collectionsDeleted > 0
      ? `, ${result.collectionsDeleted} empty collections deleted`
      : "";
  setStatus(
    win,
    `Applied: ${result.collectionsCreated} collections created, ` +
      `${result.itemsRefiled} items refiled${delLine}${errLine}.`,
    result.errors.length > 0 ? "error" : "success",
  );

  // Enable Revert now that a snapshot exists.
  const revertBtn = win.document.getElementById("smartorganizer-revert") as any;
  if (revertBtn) revertBtn.disabled = false;
}

/**
 * Revert: confirm with the user, then restore from the captured snapshot.
 */
async function onRevert(win: Window): Promise<void> {
  Zotero.debug("[SmartOrganizer] onRevert: entry");
  if (!state.snapshot) {
    Zotero.debug("[SmartOrganizer] onRevert: no snapshot; aborting");
    setStatus(win, "No snapshot to revert from.", "error");
    return;
  }
  const ok = Services.prompt.confirm(
    win as any,
    "Smart Organizer",
    "Revert the library to its pre-apply state? This will restore every " +
      "item's collection memberships and delete collections created by the " +
      "apply (if now empty).",
  );
  if (!ok) return;

  setStatus(win, "Reverting…", "busy");
  try {
    const result = await revertFromSnapshot(state.snapshot);
    setStatus(
      win,
      `Reverted: ${result.itemsRestored} items restored, ` +
        `${result.collectionsDeleted} collections deleted` +
        (result.errors.length > 0
          ? `, ${result.errors.length} errors`
          : "") +
        ".",
      result.errors.length > 0 ? "error" : "success",
    );
    state.snapshot = null;
    state.lastApply = null;
    const revertBtn = win.document.getElementById(
      "smartorganizer-revert",
    ) as any;
    if (revertBtn) revertBtn.disabled = true;
  } catch (e) {
    setStatus(
      win,
      `Revert failed: ${(e as Error).message ?? String(e)}`,
      "error",
    );
  }
}

/**
 * Regenerate: re-run `generatePlan` and re-render the tree. Does NOT touch
 * the snapshot or apply state (the user has not applied since the last
 * regenerate, so the previous snapshot, if any, remains valid).
 */
async function onRegenerate(win: Window): Promise<void> {
  state.plan = null;
  await startGenerating(win);
  if (state.plan) {
    setStatus(win, "Plan regenerated.", "success");
  }
}

function setStatus(
  win: Window,
  message: string,
  kind: "info" | "busy" | "success" | "error",
): void {
  const el = win.document.getElementById("smartorganizer-status") as any;
  if (!el) return;
  // Use setAttribute("value", ...) for XUL <description> — textContent
  // doesn't render reliably on single-line XUL elements.
  el.setAttribute("value", message);
  el.classList.remove("busy", "success", "error");
  if (kind !== "info") el.classList.add(kind);
  // Also log to debug so the user can see it even if XUL doesn't render.
  Zotero.debug(`[SmartOrganizer] STATUS: ${message}`);
}

/**
 * Re-exported for the menu/hook wiring. Documented re-export; does not modify
 * Gate 1–3 source files.
 */
export { config };
