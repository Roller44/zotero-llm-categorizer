# Architecture Overview

This document is the top-level entry point for the **Zotero Smart Organizer** developer documentation. It describes the plugin's purpose, its two-stage LLM-assisted categorization pipeline, the four-gate development model that governs how features are built, the technology stack, and how the modules wired together in `src/` relate to one another. Companion documents (referenced by filename at the end of this file) drill into individual modules.

---

## 1. Purpose

The Zotero Smart Organizer is a Zotero 7+ plugin that uses a Large Language Model (LLM) to help a researcher organize a Zotero library that has grown out of control. Rather than sorting items by hand, the user points the plugin at their library; the plugin reads the library's items and existing collections, asks an LLM to **propose a taxonomy** of collections tailored to that library, asks the LLM again to **classify each item** under the proposed taxonomy, presents the resulting plan in a **human review window**, and — only after the user approves — **applies** the plan to the live Zotero library.

The design is deliberately human-in-the-loop: the LLM never writes to the library directly. Every collection creation, item move, and tag change goes through a reviewable, revertible plan. A snapshot is taken before application so the whole operation can be rolled back (`revertSnapshot.ts`).

`package.json:5` summarizes this as *"Zotero Smart Organizer - LLM-assisted library categorization"*.

---

## 2. The Two-Stage Pipeline

The plugin's runtime work is split into two LLM stages separated by a human review surface:

```
 readLibrary()            Stage 1: Taxonomy Proposal            Stage 2: Batch Classification
 ─────────────            ────────────────────────────          ──────────────────────────────
  Zotero items   ──▶  promptBuilder  ──▶  taxonomyStage  ──▶  classificationStage
  existing cols        (build prompt)     (LLM: propose       (LLM: assign each item
                                          collection tree)     to a taxonomy node)
                                                                    │
                                                                    ▼
                          planApplier  ◀──  organizerUI  ◀──  planValidator
                          (write to        (human review       (validate LLM
                           Zotero)         window)             output)
                                                                    │
                                                                    ▼
                                                              revertSnapshot
                                                              (pre-apply backup)
```

1. **Read** — `libraryReader.ts` walks the live Zotero library and produces a `LibrarySummary` plus the item/collection records the LLM needs. This stage performs **no writes and no LLM calls**; it is exposed as a standalone debug menu item (`hooks.ts:127` `runDebugReadLibrary`) so Gate 2 can be verified independently.

2. **Stage 1 — Taxonomy Proposal** — `taxonomyStage.ts` calls the LLM through `llmClient.ts` / `llmRequest.ts` with a prompt assembled by `promptBuilder.ts` and asks for a proposed collection tree (`collectionTree.ts`). The result is parsed into the shared `categorizationTypes.ts` structures.

3. **Stage 2 — Batch Classification** — `classificationStage.ts` sends the items and the approved taxonomy back to the LLM and receives a per-item categorization plan.

4. **Validate** — `planValidator.ts` checks the LLM's plan against the library for orphan references, unknown collections, malformed entries, etc.

5. **Review** — `organizerUI.ts` opens a `chrome://` review window (`DialogHelper` from `zotero-plugin-toolkit`) where the user inspects, edits, and approves the plan.

6. **Apply** — `planApplier.ts` applies the approved plan to Zotero, creating collections and moving items. Before applying, `revertSnapshot.ts` records the prior state so the operation can be undone.

The menu item that drives stages 1+2+review is registered in `hooks.ts:107` (`ORGANIZE_MENU_ID`), whose `onCommand` calls `openReviewWindow()` from `organizerUI.ts` (`hooks.ts:13`).

---

## 3. The Four-Gate Development Model

The codebase and its work orders are organized around four progressively wider "gates". Each gate has its own acceptance check and its own menu/entry surface, so a gate can be exercised in isolation before the next one is built. The two menu items registered in `registerDebugMenu()` (`hooks.ts:91`) map directly onto this model:

| Gate | Scope | Entry point | What it must NOT do |
|------|-------|-------------|---------------------|
| **Gate 1** — Types & scaffolding | Shared types in `categorizationTypes.ts`, plugin skeleton, build pipeline. | (compile-time) | No LLM, no Zotero reads. |
| **Gate 2** — Read library | `libraryReader.ts` + the **"Smart Organizer: Read Library (debug)"** menu item. | `runDebugReadLibrary` (`hooks.ts:127`) | No writes, no LLM calls. Reports a `LibrarySummary` via `Zotero.debug` and a `ProgressWindow`. |
| **Gate 3** — Categorization without applying | `categorizer.ts`, `taxonomyStage.ts`, `classificationStage.ts`, `llmClient.ts`, `promptBuilder.ts`. Originally had its own "Run Categorization (debug)" menu item. | (now folded into Gate 4) | No writes to the Zotero library. |
| **Gate 4** — Apply with review | `organizerUI.ts` review window + `planValidator.ts` + `planApplier.ts` + `revertSnapshot.ts`, exposed via the **"Smart Organizer: Organize Library"** menu item. | `openReviewWindow()` (`hooks.ts:115`) | Never applies without human approval. Always snapshot first. |

The doc-comment at `hooks.ts:82` records an explicit design rule: the Gate 4 menu item *"Replaces Gate 3's 'Run Categorization (debug)' item."* — Gate 3 is no longer directly exposed; its logic is invoked from inside Gate 4's review flow. Keeping the Gate 2 debug item is intentional and is called out at `hooks.ts:86`: *"Kept as-is per the work order."*

The gate model exists so that each layer can be tested before the next is built: you can confirm the library reader is correct with zero LLM cost (Gate 2), then confirm the LLM prompts return sane taxonomies without risking the library (Gate 3), and only then wire in the apply path (Gate 4).

---

## 4. Technology Stack

| Layer | Choice | Source |
|-------|--------|--------|
| Language | TypeScript 5.9 (`package.json:44`) | strict, ESM (`"type": "module"`, `package.json:3`) |
| Bundler | esbuild, driven by `zotero-plugin-scaffold` | `zotero-plugin.config.ts:29` (`esbuildOptions`) |
| Build target | `firefox115` (Zotero 7's platform) | `zotero-plugin.config.ts:36` |
| Plugin framework | `zotero-plugin-toolkit` ^5.1.0-beta.13 | `package.json:33` |
| Scaffold / dev server | `zotero-plugin-scaffold` ^0.8.2 | `package.json:46` |
| Type definitions | `zotero-types` ^4.1.0-beta.4 | `package.json:47` |
| Lint / format | ESLint 9 + Prettier 3, `@zotero-plugin/eslint-config` | `package.json:39`, `package.json:43` |
| Test | Mocha 11 + Chai 6, run via `zotero-plugin test` | `package.json:42`, `package.json:41` |
| Host | Zotero 7.0 – 10.0.\* | `addon/manifest.json:16` |
| License | AGPL-3.0-or-later | `package.json:22` |

The single runtime dependency is `zotero-plugin-toolkit` — everything else is dev-time. The build emits one bundled script, `.scaffold/build/addon/content/scripts/smartorganizer.js` (`zotero-plugin.config.ts:37`), which `bootstrap.js` loads via `Services.scriptloader.loadSubScript` (`bootstrap.js:30`).

### Build-time `define` injection

The scaffold injects build-time constants into the bundle and into `addon/manifest.json`:

```ts
// zotero-plugin.config.ts:18
define: {
  ...pkg.config,        // addonName, addonID, addonRef, addonInstance, prefsPrefix
  author: pkg.author,
  description: pkg.description,
  homepage: pkg.homepage,
  buildVersion: pkg.version,
  buildTime: "{{buildTime}}",
}
```

`__env__` is injected separately from `process.env.NODE_ENV` (`zotero-plugin.config.ts:33`) and consumed at `addon.ts:33` to set `this.data.env`. The `__addon*__` placeholders in `addon/manifest.json` (e.g. `addon/manifest.json:14` `"id": "__addonID__"`) are replaced at package time, which is why the manifest in source looks unresolvable.

---

## 5. Plugin Lifecycle and Bootstrap

Zotero plugins are Mozilla-style bootstrapped add-ons. The entry chain is:

1. **`addon/bootstrap.js`** — raw JS in the Mozilla sandbox. `startup()` (`bootstrap.js:12`) registers a `chrome://` content handle under the `__addonRef__` namespace, builds a sandbox context `ctx` with `_globalThis = ctx` (`bootstrap.js:28`), loads the bundled `content/scripts/__addonRef__.js` into that context, and then calls `Zotero.__addonInstance__.hooks.onStartup()` (`bootstrap.js:34`).
2. **`src/index.ts`** — the bundled script's entry. It instantiates the `Addon` class **once per plugin instance** (guarded by `if (!basicTool.getGlobal("Zotero")[config.addonInstance])` at `index.ts:8`), assigns it to `Zotero.SmartOrganizer` (`index.ts:14`), and exposes `ztoolkit` as a lazy global via `defineGlobal` (`index.ts:19`). The `defineGlobal` helper uses `Object.defineProperty` with a getter so the global is computed on demand and never shadowed.
3. **`src/addon.ts`** — the `Addon` class holds all mutable plugin state in `this.data` (`addon.ts:7`) and exposes `hooks` and `api`. The constructor calls `createZToolkit()` (`addon.ts:35`).
4. **`src/hooks.ts`** — the actual lifecycle dispatcher. `onStartup` (`hooks.ts:22`) awaits three Zotero readiness promises (`initializationPromise`, `unlockPromise`, `uiReadyPromise`), initializes locale, registers prefs, registers main-window hooks for every existing main window, and finally sets `addon.data.initialized = true` (`hooks.ts:37`). That flag is what the scaffold's test runner polls — `zotero-plugin.config.ts:43` waits for `() => Zotero.SmartOrganizer.data.initialized`.

### Shutdown and cleanup

`onShutdown` (`hooks.ts:56`) calls `ztoolkit.unregisterAll()`, flips `addon.data.alive = false`, and `delete Zotero[addonInstance]`. `onMainWindowUnload` (`hooks.ts:50`) unregisters the two menu IDs (`Zotero.MenuManager.unregisterMenu`) and again `ztoolkit.unregisterAll()`. `bootstrap.js:46` short-circuits `shutdown` when `reason === APP_SHUTDOWN` to avoid tearing down the plugin during a normal Zotero quit, and otherwise delegates to `hooks.onShutdown` and destructs the chrome handle (`bootstrap.js:52`).

A design rule is stated in the comment at `hooks.ts:78`: *"Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks. Otherwise the code would be hard to read and maintain."* Real work lives in `src/modules/*`; `hooks.ts` only wires menu items to those module functions.

### Why no `onOrganizerLoad` hook

The comment block at `hooks.ts:14` records a deliberate non-decision: the review window is **not** initialized through a hook on the `chrome://` window scope, because that scope does not expose `Zotero.SmartOrganizer`. Instead `openReviewWindow()` in `organizerUI.ts` awaits the chrome window's `load` event and then calls `initOrganizerUI` from the plugin context. There is therefore no `onOrganizerLoad` hook — a fact worth noting before adding one.

---

## 6. Configuration Surfaces

Three files cooperate to define the plugin's identity, and they must stay consistent:

| Field | `package.json` (source of truth) | `zotero-plugin.config.ts` (build) | `addon/manifest.json` (output) |
|-------|----------------------------------|-----------------------------------|--------------------------------|
| Add-on ID | `config.addonID` = `zotero-llm-categorizer@github.com` (`package.json:8`) | `id: pkg.config.addonID` (`config.ts:8`) | `__addonID__` → replaced (`manifest.json:14`) |
| Ref / namespace | `config.addonRef` = `smartorganizer` (`package.json:9`) | `namespace: pkg.config.addonRef` (`config.ts:9`); used for the chrome URL and the bundled script name | `__addonRef__` → replaced (`manifest.json:18`, `bootstrap.js:18`) |
| JS instance | `config.addonInstance` = `SmartOrganizer` (`package.json:10`) | consumed in `index.ts:8`, `hooks.ts:60` | `__addonInstance__` → replaced (`bootstrap.js:34`) |
| Prefs prefix | `config.prefsPrefix` = `extensions.zotero-smart-organizer` (`package.json:11`) | `build.prefs.prefix` (`config.ts:27`) | — |
| xpi name | — | `xpiName: "zotero-llm-categorizer"` (`config.ts:10`) | — |

Update URLs point at the GitHub Releases artifact (`config.ts:11`), and `addon/manifest.json:15` carries the placeholder `__updateURL__` that the scaffold fills in.

---

## 7. Module Map

The plugin's runtime code lives under `src/modules/` (15 files) and `src/utils/` (5 files). Each module is the subject of its own companion doc; this section gives the one-line role of each so the diagram below is readable.

**`src/modules/`** (pipeline stages and supporting types)

| File | Role |
|------|------|
| `categorizationTypes.ts` | Shared TypeScript types for taxonomy nodes, categorization plans, LLM I/O. The contract between every other module. |
| `libraryReader.ts` | Reads the live Zotero library: items, collections, attachments, tags. Exports `readLibrary`, `summarizeLibrary`, `LibrarySummary`. Gate 2. |
| `libraryModel.ts` | In-memory model of the library used by prompt builders and validators. |
| `collectionTree.ts` | Tree representation of an (existing or proposed) collection taxonomy. |
| `promptBuilder.ts` | Assembles the JSON prompts sent to the LLM for both stages. |
| `llmRequest.ts` | Low-level HTTP/request shape to the LLM endpoint. |
| `llmClient.ts` | Higher-level client: retry, parsing, error normalization around `llmRequest`. |
| `taxonomyStage.ts` | Stage 1 — calls LLM to propose a taxonomy. |
| `classificationStage.ts` | Stage 2 — calls LLM to classify each item under the taxonomy. |
| `categorizer.ts` | Orchestrates Stage 1 + Stage 2 into one "generate a plan" call used by Gate 4. |
| `planValidator.ts` | Validates the LLM-produced plan against the live library before review. |
| `organizerUI.ts` | Opens and runs the human review `chrome://` window (`DialogHelper`). Exports `openReviewWindow`, `initOrganizerUI`. |
| `planApplier.ts` | Applies the approved plan to Zotero (create collections, move items, set tags). |
| `revertSnapshot.ts` | Snapshots pre-apply state and restores it on revert. |
| `preferenceScript.ts` | Preference pane wiring; `registerPrefs`, `registerPrefsScripts` consumed by `hooks.ts`. |

**`src/utils/`**

| File | Role |
|------|------|
| `ztoolkit.ts` | `createZToolkit()` — constructs the typed `ZToolkit` instance held in `addon.data.ztoolkit`. |
| `locale.ts` | `initLocale()` — loads FTL localization. |
| `prefs.ts` | Preference get/set helpers under `prefsPrefix`. |
| `window.ts` | Window/dialog helpers used by the review UI. |
| `domHelpers.ts` | Small DOM utilities for the review window's content. |

The two non-`modules/` source files — `src/index.ts` and `src/addon.ts` — are the bootstrap and the singleton state holder described in §5.

---

## 8. Module Dependency Diagram

```
                       addon/bootstrap.js   (Mozilla sandbox; loads the bundle)
                                │
                                ▼
                         src/index.ts        (singleton guard; defines `ztoolkit` global)
                                │
                                ▼
                          src/addon.ts       (Addon singleton: data, hooks, api)
                                │
                                ▼
                          src/hooks.ts       (lifecycle dispatcher only)
                                │
            ┌───────────────────┼──────────────────────┬──────────────────┐
            ▼                   ▼                      ▼                  ▼
   modules/preferenceScript  libraryReader        organizerUI        (MenuManager
            │                   │                      │              registrations)
            │                   │                      │
            │                   ▼                      ▼
            │             LibrarySummary         openReviewWindow()
            │             (Gate 2 debug)              │
            │                                        ▼
            │           ┌──────────────────── categorizer.ts ───────────────────┐
            │           │                          │                            │
            │           ▼                          ▼                            ▼
            │     taxonomyStage.ts         classificationStage.ts        promptBuilder.ts
            │           │                          │                            │
            │           └──────────┬───────────────┘                            │
            │                      ▼                                            │
            │                  llmClient.ts ◀───────────────────────────────────┘
            │                      │
            │                      ▼
            │                  llmRequest.ts
            │
            │     ┌───────────────────────────────────────────────────────┐
            │     │  organizerUI.ts (review window)                        │
            │     │      │                                                 │
            │     │      ▼                                                 │
            │     │  planValidator.ts ──▶ planApplier.ts ──▶ revertSnapshot.ts
            │     │                                                 (snapshot before apply)
            │     └───────────────────────────────────────────────────────┘
            │
            ▼
   utils/locale.ts, utils/ztoolkit.ts, utils/prefs.ts, utils/window.ts, utils/domHelpers.ts

   Shared types:  modules/categorizationTypes.ts   ◀── used by every stage module
   Shared models: modules/libraryModel.ts, modules/collectionTree.ts
```

Solid arrows mean "imports / calls into". The diagram makes three structural facts visible:

1. **`hooks.ts` is a thin dispatcher.** It only registers menus and delegates; all real work is in `modules/`.
2. **The LLM stages are isolated behind `categorizer.ts`.** `organizerUI.ts` does not talk to `taxonomyStage`/`classificationStage` directly — it goes through `categorizer.ts`, which keeps the two-stage ordering in one place.
3. **`planApplier.ts` and `revertSnapshot.ts` are the only modules that write to Zotero.** Everything to their left is read-only or pure.

---

## 9. Public API Surface

This section documents every function exposed by the bootstrap and the three top-level source files (`src/index.ts`, `src/addon.ts`, `src/hooks.ts`). Each entry below pairs a structured API block (signature, parameters, return type, throws) with the prose context that originally accompanied it — design rationale, bug history, and the citation of where in the source the behavior lives.

### `defineGlobal` (src/index.ts:17–25)

Installs a lazy global on the plugin's `_globalThis` sandbox, either as a passthrough to a Zotero global or as a custom getter.

```ts
function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | Yes | The global property name to define on `_globalThis`. |
| `getter` | `() => any` | No | Custom getter. If omitted, the getter forwards to `basicTool.getGlobal(name)`. |

**Returns:** `void`.

**Throws:** None. `Object.defineProperty` would only throw on a redefinition of a non-configurable property, which does not occur in this plugin's lifecycle.

`defineGlobal` is overloaded: with one argument it forwards to `basicTool.getGlobal(name)` (a passthrough to Zotero's globals); with two it installs a custom getter. Used at `index.ts:10` to expose `ztoolkit` lazily. The module side-effect at `index.ts:8` ensures exactly one `Addon` instance exists — guarded by `if (!basicTool.getGlobal("Zotero")[config.addonInstance])` — and assigns it to `Zotero[config.addonInstance]` at `index.ts:14`.

### `class Addon` (src/addon.ts:6–42)

Singleton holder for all mutable plugin state, plus the `hooks` dispatcher and a placeholder `api` object.

```ts
class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: { current: any };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  public hooks: typeof hooks;
  public api: object;

  constructor();
}
export default Addon;
```

**Fields (on `this.data`):**

| Field | Type | Description |
|-------|------|-------------|
| `alive` | `boolean` | `true` while the plugin is running; flipped to `false` on shutdown (`hooks.ts:58`) so other code can bail out of in-flight work. |
| `config` | `typeof config` | The `package.json` `config` block (addonName, addonID, addonRef, addonInstance, prefsPrefix). |
| `env` | `"development" \| "production"` | Build environment, injected from `__env__` at `addon.ts:33`. |
| `initialized` | `boolean?` | Set to `true` at the end of `onStartup` (`hooks.ts:37`). This is the flag the scaffold's test runner polls (`zotero-plugin.config.ts:43`). |
| `ztoolkit` | `ZToolkit` | The typed toolkit instance; rebuilt per main window via `createZToolkit()` (`hooks.ts:41`). |
| `locale` | `{ current: any }?` | Current locale resource, populated by `initLocale()`. |
| `prefs` | `{ window, columns, rows }?` | Preference-pane state for the preferences window. |
| `dialog` | `DialogHelper?` | The review-window `DialogHelper` from `zotero-plugin-toolkit` (`addon.ts:2`). |

**Constructor (addon.ts:29–39):**

```ts
constructor();
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | The constructor takes no arguments. |

**Returns:** A new `Addon` instance with `data.alive = true`, `data.env = __env__`, `data.initialized = false`, `data.ztoolkit = createZToolkit()`, `hooks` bound to the imported hooks module, and `api = {}`.

**Throws:** None explicitly. May propagate any error from `createZToolkit()`.

`data.alive` is set to `false` on shutdown (`hooks.ts:58`) so other code can bail out of in-flight work. `data.initialized` is the flag the scaffold's test runner polls (`zotero-plugin.config.ts:43`). `data.dialog` holds the review-window `DialogHelper` from `zotero-plugin-toolkit` (`addon.ts:2`). `api` is currently an empty object (`addon.ts:38`) — a placeholder for a future programmatic API. The `Addon` class is instantiated exactly once per plugin instance by `src/index.ts` (see the singleton guard note in §10).

### `src/hooks.ts` default export (src/hooks.ts:166–172)

The five lifecycle hooks that `bootstrap.js` calls into. `hooks.ts` is intentionally a thin dispatcher (see the design rule at `hooks.ts:78`); each hook delegates real work to functions in `src/modules/*`.

```ts
export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
```

### `onStartup` (src/hooks.ts:22–38)

Awaits Zotero's three readiness promises, initializes locale, registers prefs, wires every existing main window, and marks the plugin initialized.

```ts
async function onStartup(): Promise<void>;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | Takes no arguments. |

**Returns:** `Promise<void>` — resolves after `addon.data.initialized` is set to `true`.

**Throws:** None explicitly; will reject if any of `Zotero.initializationPromise`, `Zotero.unlockPromise`, `Zotero.uiReadyPromise`, `registerPrefs()`, or `onMainWindowLoad()` reject.

`onStartup` awaits three Zotero readiness promises (`initializationPromise`, `unlockPromise`, `uiReadyPromise`), initializes locale, registers prefs, registers main-window hooks for every existing main window, and finally sets `addon.data.initialized = true` (`hooks.ts:37`). That flag is what the scaffold's test runner polls — `zotero-plugin.config.ts:43` waits for `() => Zotero.SmartOrganizer.data.initialized`. Awaiting all three readiness promises in parallel means the plugin does not race Zotero's own startup; the menus are registered only after the UI is ready (see §10).

### `onShutdown` (src/hooks.ts:56–61)

Tears down the plugin: unregisters all toolkit hooks, marks the addon not alive, and deletes the global Zotero instance reference.

```ts
function onShutdown(): void;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | Takes no arguments. |

**Returns:** `void`.

**Throws:** None.

`onShutdown` calls `ztoolkit.unregisterAll()`, flips `addon.data.alive = false`, and `delete Zotero[addonInstance]`. `bootstrap.js:46` short-circuits `shutdown` when `reason === APP_SHUTDOWN` to avoid tearing down the plugin during a normal Zotero quit, and otherwise delegates to `hooks.onShutdown` and destructs the chrome handle (`bootstrap.js:52`).

### `onMainWindowLoad` (src/hooks.ts:40–48)

Rebuilds the typed toolkit for the window, inserts the window's FTL localization, and registers the Tools menu items.

```ts
async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void>;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `_ZoteroTypes.MainWindow` | Yes | The Zotero main window that has loaded. |

**Returns:** `Promise<void>`.

**Throws:** None explicitly; may reject if `createZToolkit()` or `registerDebugMenu()` throw.

`onMainWindowLoad` rebuilds `addon.data.ztoolkit` via `createZToolkit()` (`hooks.ts:41`) so the lazy `ztoolkit` global picks up the current toolkit instance (see §10), calls `win.MozXULElement.insertFTLIfNeeded` for the window's FTL file, and then calls `registerDebugMenu()` to install the two Tools-menu items.

### `onMainWindowUnload` (src/hooks.ts:50–54)

Unregisters the two Tools-menu items and all toolkit hooks for the closing window.

```ts
async function onMainWindowUnload(_win: Window): Promise<void>;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `_win` | `Window` | Yes | The window being unloaded (unused; underscore-prefixed). |

**Returns:** `Promise<void>`.

**Throws:** None.

`onMainWindowUnload` unregisters the two menu IDs (`Zotero.MenuManager.unregisterMenu`) and again `ztoolkit.unregisterAll()`.

### `onPrefsEvent` (src/hooks.ts:68–76)

Dispatcher for Preference UI events; currently handles only `"load"`, forwarding to `registerPrefsScripts`.

```ts
async function onPrefsEvent(
  type: string,
  data: { [key: string]: any },
): Promise<void>;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | `string` | Yes | Event type. Currently only `"load"` is handled; any other value returns early. |
| `data` | `{ [key: string]: any }` | Yes | Event payload. For `"load"`, must contain `data.window`. |

**Returns:** `Promise<void>`.

**Throws:** None explicitly; may reject if `registerPrefsScripts(data.window)` throws.

`onPrefsEvent` (`hooks.ts:68`) is a switch that currently handles only `"load"`, forwarding to `registerPrefsScripts`. The JSDoc on the function records its parameters (`@param type`, `@param data`).

### Internal but noteworthy functions in `hooks.ts`

### `registerDebugMenu` (src/hooks.ts:91–121)

Registers the two Tools-menu items ("Read Library (debug)" and "Organize Library") under `main/menubar/tools` via `Zotero.MenuManager.registerMenu`.

```ts
function registerDebugMenu(): void;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | Takes no arguments. |

**Returns:** `void`.

**Throws:** None explicitly; may propagate errors from `Zotero.MenuManager.registerMenu`.

`registerDebugMenu()` (`hooks.ts:91`) registers the two Tools-menu items via `Zotero.MenuManager.registerMenu`. Both target `"main/menubar/tools"`. Menu IDs are `${addonRef}-read-library` and `${addonRef}-organize` (`hooks.ts:19`). The Gate 4 item's `onCommand` calls `openReviewWindow()` from `organizerUI.ts` (`hooks.ts:13`, `hooks.ts:115`); the Gate 2 item's `onCommand` calls `runDebugReadLibrary()`. The doc-comment at `hooks.ts:82` records an explicit design rule: the Gate 4 menu item *"Replaces Gate 3's 'Run Categorization (debug)' item."* — Gate 3 is no longer directly exposed; its logic is invoked from inside Gate 4's review flow. Keeping the Gate 2 debug item is intentional and is called out at `hooks.ts:86`: *"Kept as-is per the work order."*

### `runDebugReadLibrary` (src/hooks.ts:127–164)

Gate 2 entry. Reads the live library, summarizes it, logs the full `LibrarySummary` to `Zotero.debug`, and renders a human-readable breakdown in a `ProgressWindow`. Performs no writes and no LLM calls.

```ts
async function runDebugReadLibrary(): Promise<void>;
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | Takes no arguments. |

**Returns:** `Promise<void>` — resolves after the progress window's close timer is started.

**Throws:** None. All errors from `readLibrary()` / `summarizeLibrary()` are caught, logged to `Zotero.debug`, and surfaced in the progress window; the function never throws.

`runDebugReadLibrary()` (`hooks.ts:127`) — Gate 2 entry. Creates a `Zotero.ProgressWindow`, calls `readLibrary()` then `summarizeLibrary()`, logs the full `LibrarySummary` to `Zotero.debug`, and renders a human-readable breakdown (total items, items with abstract/DOI/tag/attachment, unfiled count, top 5 collection paths). Catches errors and shows them in the progress window; never throws. This isolation is what lets Gate 2 be exercised with zero LLM cost (see §3).

### `addon/bootstrap.js` — Mozilla bootstrap API (bootstrap.js:10–58)

The Mozilla-style bootstrapped add-on entry points. `install` and `uninstall` are no-ops; `startup` is the only one that does substantive work.

### `install` (bootstrap.js:10)

No-op stub required by the Mozilla bootstrap contract.

```js
function install(data, reason) {}
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `data` | `object` | Yes | Add-on metadata supplied by the host. Unused. |
| `reason` | `number` | Yes | Mozilla install-reason constant. Unused. |

**Returns:** `void`.

**Throws:** None.

### `startup` (bootstrap.js:12–35)

Registers the `chrome://__addonRef__/content/` URL, constructs the plugin sandbox `ctx`, loads the bundled script, and invokes `hooks.onStartup`.

```js
async function startup(
  { id, version, resourceURI, rootURI },
  reason,
)
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `{ id, version, resourceURI, rootURI }` | `object` | Yes | Add-on parameters; `rootURI` is used to locate `manifest.json` and the bundled script. |
| `reason` | `number` | Yes | Mozilla startup-reason constant. |

**Returns:** `Promise<void>` — resolves after `Zotero.__addonInstance__.hooks.onStartup()` completes.

**Throws:** None explicitly; will reject if `loadSubScript` fails or `onStartup` rejects.

`startup` is the only bootstrap function that does substantive work: it registers the `chrome://__addonRef__/content/` URL (`bootstrap.js:17`), constructs the sandbox `ctx` with `_globalThis = ctx` (`bootstrap.js:28`), loads the bundled `content/scripts/__addonRef__.js` into that context (`bootstrap.js:30`), and invokes `Zotero.__addonInstance__.hooks.onStartup()` (`bootstrap.js:34`). This is the hand-off from the Mozilla sandbox into the bundled TypeScript code described in §5.

### `onMainWindowLoad` (bootstrap.js:37–39)

Forwards to `hooks.onMainWindowLoad`, guarded with optional chaining in case the bundle failed to load.

```js
async function onMainWindowLoad({ window }, reason)
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `{ window }` | `object` | Yes | The newly loaded main window. |
| `reason` | `number` | Yes | Mozilla window-load reason constant. |

**Returns:** `Promise<void>`.

**Throws:** None. The optional-chaining on `Zotero.__addonInstance__?.hooks` guards against the case where the bundle failed to load and `Zotero.SmartOrganizer` was never assigned.

Note the optional-chaining on `Zotero.__addonInstance__?.hooks` in the window/shutdown callbacks (`bootstrap.js:38`, `bootstrap.js:42`, `bootstrap.js:50`) — this guards against the case where the bundle failed to load and `Zotero.SmartOrganizer` was never assigned.

### `onMainWindowUnload` (bootstrap.js:41–43)

Forwards to `hooks.onMainWindowUnload`, guarded with optional chaining.

```js
async function onMainWindowUnload({ window }, reason)
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `{ window }` | `object` | Yes | The window being unloaded. |
| `reason` | `number` | Yes | Mozilla window-unload reason constant. |

**Returns:** `Promise<void>`.

**Throws:** None (optional-chained).

### `shutdown` (bootstrap.js:45–56)

Short-circuits on `APP_SHUTDOWN`; otherwise delegates to `hooks.onShutdown` and destructs the chrome handle.

```js
async function shutdown({ id, version, resourceURI, rootURI }, reason)
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `{ id, version, resourceURI, rootURI }` | `object` | Yes | Add-on parameters. |
| `reason` | `number` | Yes | Mozilla shutdown-reason constant. If `reason === APP_SHUTDOWN`, the function returns immediately. |

**Returns:** `Promise<void>`.

**Throws:** None.

`bootstrap.js:46` short-circuits `shutdown` when `reason === APP_SHUTDOWN` to avoid tearing down the plugin during a normal Zotero quit, and otherwise delegates to `hooks.onShutdown` and destructs the chrome handle (`bootstrap.js:52`). This avoids spurious errors in the console on quit (see §10).

### `uninstall` (bootstrap.js:58)

No-op stub required by the Mozilla bootstrap contract.

```js
async function uninstall(data, reason) {}
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `data` | `object` | Yes | Add-on metadata. Unused. |
| `reason` | `number` | Yes | Mozilla uninstall-reason constant. Unused. |

**Returns:** `Promise<void>`.

**Throws:** None.

### `addon/manifest.json` constants (addon/manifest.json:1–20)

The manifest carries Mozilla/Zotero add-on metadata. The `__addon*__` placeholders are replaced at package time by the scaffold, which is why the manifest in source looks unresolvable.

| Field | Source value | Description |
|-------|--------------|-------------|
| `manifest_version` | `2` | Mozilla manifest schema version. |
| `name` | `__addonName__` | Replaced from `package.json` `config.addonName` at build time. |
| `version` | `__buildVersion__` | Replaced from `pkg.version` (`config.ts:18`). |
| `description` | `__description__` | Replaced from `pkg.description`. |
| `homepage_url` | `__homepage__` | Replaced from `pkg.homepage`. |
| `author` | `__author__` | Replaced from `pkg.author`. |
| `applications.zotero.id` | `__addonID__` | Replaced from `config.addonID` = `zotero-llm-categorizer@github.com` (`package.json:8`). |
| `applications.zotero.update_url` | `__updateURL__` | Filled in from the GitHub Releases artifact URL (`config.ts:11`). |
| `applications.zotero.strict_min_version` | `"7.0"` | Minimum supported Zotero version. |
| `applications.zotero.strict_max_version` | `"10.0.*"` | Maximum supported Zotero version (host range stated in §4). |

---

## 10. Key Design Decisions

- **Singleton guard in `index.ts:8`.** Because `bootstrap.js` can load the same subscript more than once across reinstalls, `index.ts` checks `Zotero[config.addonInstance]` before constructing a new `Addon`. Without this guard, every reinstall would stack a second `Addon` instance and double-register menus.
- **Lazy `ztoolkit` global.** `defineGlobal("ztoolkit", ...)` (`index.ts:10`) installs a getter that returns `_globalThis.addon.data.ztoolkit`. This means `ztoolkit` is always the *current* toolkit instance — `onMainWindowLoad` rebuilds it via `createZToolkit()` (`hooks.ts:41`), and the getter picks that up automatically.
- **No real work in hooks.** Stated at `hooks.ts:78`. This keeps `hooks.ts` readable and makes the modules independently testable.
- **Three Zotero readiness promises awaited in `onStartup`.** `Zotero.initializationPromise`, `Zotero.unlockPromise`, `Zotero.uiReadyPromise` (`hooks.ts:23`). Awaiting all three in parallel means the plugin does not race Zotero's own startup; the menus are registered only after the UI is ready.
- **`APP_SHUTDOWN` short-circuit.** `bootstrap.js:46` returns early on `APP_SHUTDOWN` so that closing Zotero does not run `onShutdown`'s unregister logic against an already-tearing-down host. This avoids spurious errors in the console on quit.
- **Two-stage LLM call, not one.** Splitting taxonomy proposal from classification lets the user inspect and edit the taxonomy before items are classified against it — a cheaper, more reviewable interaction than asking the LLM for a flat plan in one shot.
- **Human review is mandatory.** There is no code path that applies a plan without going through `organizerUI.ts`. Even the Gate 4 menu item opens the review window (`hooks.ts:115`), it does not apply directly.
- **Revert snapshot always precedes apply.** `revertSnapshot.ts` is on the apply path, not optional, so a botched categorization can be rolled back.

---

## 11. Building, Running, Testing

Scripts from `package.json:23`:

| Command | Effect |
|---------|--------|
| `npm start` | `zotero-plugin serve` — rebuild on change and hot-reload into a running Zotero. |
| `npm run build` | `zotero-plugin build && tsc --noEmit` — produce the xpi **and** type-check the source. |
| `npm run lint:check` | `prettier --check . && eslint .` |
| `npm run lint:fix` | `prettier --write . && eslint . --fix` |
| `npm test` | `zotero-plugin test` — runs Mocha tests inside a Zotero instance; the runner waits for `Zotero.SmartOrganizer.data.initialized` (`config.ts:43`). |
| `npm run release` | `zotero-plugin release` — cuts a release xpi and `update.json`. |

Build output goes to `.scaffold/build` (`config.ts:6`); the bundled entry is `.scaffold/build/addon/content/scripts/smartorganizer.js` (`config.ts:37`).

---

## 12. Companion Documents

This file is the overview. Each subsystem has its own deep-dive doc in this folder. The actual filenames present in `docs/` are:

| Doc | Covers |
|-----|--------|
| `02-plugin-lifecycle.md` | Bootstrap, singleton, hooks, shutdown — §5 in greater depth. |
| `03-categorization-pipeline.md` | End-to-end pipeline: taxonomy → classify → validate → review → apply → revert. |
| `04-library-reading.md` | Gate 2: `libraryReader.ts`, `LibrarySummary`, the read-only contract. |
| `05-llm-client.md` | `llmClient.ts` and `llmRequest.ts` — HTTP, retry, JSON parsing. |
| `06-taxonomy-stage.md` | Stage 1: `taxonomyStage.ts`, `promptBuilder.ts` (taxonomy prompt). |
| `07-classification-stage.md` | Stage 2: `classificationStage.ts`, `promptBuilder.ts` (classify prompt). |
| `08-plan-validator.md` | `planValidator.ts` — validators for LLM output. |
| `09-plan-applier.md` | `planApplier.ts` — the only module that mutates collections. |
| `10-revert-snapshot.md` | `revertSnapshot.ts` — snapshot and revert for the applier. |
| `11-organizer-ui.md` | `organizerUI.ts`, `domHelpers.ts` — the review window. |
| `12-preferences.md` | `preferenceScript.ts`, `prefs.ts` — the preferences pane. |
| `13-prompt-builder.md` | `promptBuilder.ts` — system prompts, retry prompts, custom prompt override. |
| `14-utilities.md` | `src/utils/*` — domHelpers, locale, prefs, window, ztoolkit. |
| `15-tests.md` | Mocha/Chai setup, `zotero-plugin test`, the `waitForPlugin` contract. |
| `16-api-reference.md` | Structured API reference: every exported function, type, and constant across all modules. |

Read this file first, then follow the pipeline order (`03` → `04` → `05` → `06` → `07` → `08` → `11` → `09` → `10`) for the full apply path. `02` complements §5 of this file; `12`, `13`, `14`, `15`, and `16` are standalone reference docs.
