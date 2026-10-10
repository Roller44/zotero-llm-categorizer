# Plugin Lifecycle and Bootstrap

This document describes how the Zotero Smart Organizer plugin starts up, registers itself with the Zotero host application, wires up its menus and preference pane, and tears itself down on shutdown. It traces the full path from the WebExtension-style bootstrap entry point (`addon/bootstrap.js`) through the TypeScript sandbox initializer (`src/index.ts`), the singleton addon object (`src/addon.ts`), and the lifecycle hooks (`src/hooks.ts`).

The bootstrap sequence at a glance:

```
Zotero loads XPI
  └─ bootstrap.js: startup()
       ├─ registerChrome("content", "__addonRef__", rootURI + "content/")
       ├─ loadSubScript("content/scripts/__addonRef__.js", ctx)   ← src/index.ts compiled
       │     └─ new Addon() → _globalThis.addon
       │     └─ Zotero[config.addonInstance] = addon              ← Zotero.SmartOrganizer
       └─ Zotero.__addonInstance__.hooks.onStartup()              ← hooks.ts
            ├─ await Zotero.initializationPromise / unlockPromise / uiReadyPromise
            ├─ initLocale()
            ├─ registerPrefs()                                     ← preference pane
            └─ for each main window: onMainWindowLoad(win)
                 ├─ createZToolkit()
                 ├─ insertFTLIfNeeded("smartorganizer-mainWindow.ftl")
                 └─ registerDebugMenu()                           ← Tools menu items
```

## Identity and naming: `addonID`, `addonRef`, `addonInstance`

The plugin's identity is defined in `package.json` under `config` and is the single source of truth that every other file reads from. Three distinct identifiers serve three distinct roles:

| Field             | Value                            | Role                                                                 | Where consumed                                                   |
|-------------------|----------------------------------|----------------------------------------------------------------------|------------------------------------------------------------------|
| `addonID`         | `zotero-llm-categorizer@github.com` | WebExtension add-on ID. Used for `Zotero.MenuManager.registerMenu({ pluginID })`, `Zotero.PreferencePanes.register({ pluginID })`, and the manifest's `applications.zotero.id`. | `hooks.ts:94,108`; `preferenceScript.ts:22`; `manifest.json:14` (via `__addonID__`) |
| `addonRef`        | `smartorganizer`                 | Short, lowercase identifier used for chrome:// URL registration (`chrome://smartorganizer/content/...`), FTL file names, menu l10n IDs, and build-time token substitution (`__addonRef__`) in `bootstrap.js`. | `bootstrap.js:18,31`; `hooks.ts:19,20,44,99,114`; `preferenceScript.ts:25`; `ztoolkit.ts:30` |
| `addonInstance`   | `SmartOrganizer`                 | The property name under which the singleton `Addon` instance is hung on the global `Zotero` object, i.e. `Zotero.SmartOrganizer`. | `index.ts:8,14`; `bootstrap.js:34`; `hooks.ts:60`               |
| `addonName`       | `Zotero Smart Organizer`         | Human-readable name. Surfaced in the manifest (`__addonName__`) and the ztoolkit log prefix. | `manifest.json:3`; `ztoolkit.ts:19`                             |
| `prefsPrefix`     | `extensions.zotero-smart-organizer` | Zotero preference branch prefix.                                     | `preferenceScript.ts:9,64,74`                                    |

### Why three identifiers instead of one

Zotero plugins live in several namespaces at once, and each namespace has its own casing/character rules:

- The **add-on ID** must be a valid WebExtension ID (email-like or GUID), so it can never double as a JS property name.
- The **chrome:// URL** segment must be lowercase and is registered verbatim with `aomStartup.registerChrome` (`bootstrap.js:17-19`). The same lowercased string is reused for FTL file names and l10n IDs to keep a single visual identity.
- The **JS global** on `Zotero` is conventionally PascalCased (`Zotero.SmartOrganizer`) so it reads as a class instance and does not collide with built-in Zotero properties.

Keeping them in `package.json.config` lets the build (`zotero-plugin-scaffold`) substitute `__addonID__`, `__addonRef__`, `__addonInstance__`, etc. into `bootstrap.js` and `manifest.json` at packaging time, while the TypeScript sources import the same values at compile time (`import { config } from "../package.json"`). There is exactly one source of truth.

## `addon/manifest.json` — the WebExtension manifest

```json
{
  "manifest_version": 2,
  "name": "__addonName__",
  "version": "__buildVersion__",
  "applications": { "zotero": {
    "id": "__addonID__",
    "strict_min_version": "7.0",
    "strict_max_version": "10.0.*"
  }}
}
```

- `manifest_version: 2` — Zotero 7 uses the Mozilla WebExtension manifest v2 format; `__addonID__`, `__buildVersion__`, `__addonName__`, `__description__`, `__homepage__`, `__author__`, and `__updateURL__` are placeholders substituted by the build tooling (`manifest.json:3-7,15`).
- `strict_min_version: "7.0"` and `strict_max_version: "10.0.*"` declare compatibility with Zotero 7 through 10. The plugin relies on Zotero 7 APIs (`Zotero.MenuManager.registerMenu`, `Zotero.PreferencePanes.register`, `MozXULElement.insertFTLIfNeeded`) that do not exist in Zotero 6, hence the floor at 7.0.
- `icons` (lines 8-11) point at `content/icons/favicon.png` and its 0.5x variant, resolved relative to the add-on root.

## `addon/bootstrap.js` — the bootstrap entry point

`bootstrap.js` is the low-level entry point Zotero calls directly. It is plain JavaScript (no TypeScript, no bundler) running in the privileged bootstrap scope. The header comment (`bootstrap.js:1-6`) attributes the structure to Zotero's official "Make It Red" sample and the Zotero 7 developer docs.

### Module-level state

```js
var chromeHandle;   // bootstrap.js:8
```

`chromeHandle` holds the opaque handle returned by `aomStartup.registerChrome` so it can be destructed on shutdown (line 53). It is intentionally module-scoped rather than attached to `Zotero` because it is only meaningful inside the bootstrap scope.

### install

No-op install handler called by Zotero when the add-on is first installed.

```ts
function install(data: AddonData, reason: integer): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `data` | `AddonData` | Yes | Add-on metadata (`{ id, version, resourceURI, rootURI }`). Unused. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Unused. |

**Returns:** `void` — no return value.

**Throws:** None.

`install` is an empty no-op (`bootstrap.js:10`). The plugin does all of its work in `startup`/`shutdown`. There is no install-time migration to perform because all preferences are created lazily by `preferenceScript.ts` when the pane first loads.

### uninstall

No-op uninstall handler called by Zotero when the add-on is uninstalled.

```ts
async function uninstall(data: AddonData, reason: integer): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `data` | `AddonData` | Yes | Add-on metadata. Unused. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Unused. |

**Returns:** `Promise<void>` — resolves immediately.

**Throws:** None.

`uninstall` is an empty no-op (`bootstrap.js:58`), for the same reason as `install`: all cleanup happens in `shutdown`.

### startup

Called by Zotero when the add-on is enabled or first installed. Registers the `chrome://` package, loads the compiled TypeScript bundle into a sandbox, and dispatches to the TypeScript-side `onStartup` hook.

```ts
async function startup(
  { id, version, resourceURI, rootURI }: AddonData,
  reason: integer,
): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | Yes | Add-on ID. Unused. |
| `version` | `string` | Yes | Add-on version. Unused. |
| `resourceURI` | `string` | Yes | Add-on resource URI. Unused. |
| `rootURI` | `string` | Yes | Root URI of the add-on; used to resolve `manifest.json`, the compiled bundle, and the `content/` directory. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Unused here (only `shutdown` branches on it). |

**Returns:** `Promise<void>` — resolves once the TypeScript-side `onStartup` hook has resolved.

**Throws:** Propagates any rejection from `aomStartup.registerChrome`, `Services.io.newURI`, `Services.scriptloader.loadSubScript`, or `Zotero.__addonInstance__.hooks.onStartup()`.

It performs three jobs:

1. **Register the chrome:// URL.** Lines 13-19:

   ```js
   const aomStartup = Components.classes[
     "@mozilla.org/addons/addon-manager-startup;1"
   ].getService(Components.interfaces.amIAddonManagerStartup);
   const manifestURI = Services.io.newURI(rootURI + "manifest.json");
   chromeHandle = aomStartup.registerChrome(manifestURI, [
     ["content", "__addonRef__", rootURI + "content/"],
   ]);
   ```

   This maps the `content` package name `smartorganizer` (after `__addonRef__` substitution) to the on-disk directory `rootURI + "content/"`. From this point on, `chrome://smartorganizer/content/<path>` resolves to files under that directory. This registration must happen *before* any `chrome://` URL is opened, which is why it is the first thing in `startup`.

2. **Load the compiled plugin script.** Lines 27-33:

   ```js
   const ctx = { rootURI };
   ctx._globalThis = ctx;
   Services.scriptloader.loadSubScript(
     `${rootURI}/content/scripts/__addonRef__.js`,
     ctx,
   );
   ```

   The compiled bundle (`src/index.ts` and everything it imports) is loaded into a sandboxed context `ctx`. `ctx._globalThis = ctx` makes `_globalThis` self-referential inside the sandbox, which is the convention the TypeScript sources rely on (`index.ts:9,11` write `_globalThis.addon`). `rootURI` is passed in so the bundle can resolve `chrome://` URLs and other resources.

3. **Invoke the lifecycle hook.** Line 34:

   ```js
   await Zotero.__addonInstance__.hooks.onStartup();
   ```

   By the time `loadSubScript` returns, `Zotero.SmartOrganizer` exists (see `index.ts:14`), so bootstrap can hand control to the TypeScript-side hook.

### onMainWindowLoad

Forwards a main-window load event from Zotero to the TypeScript-side `onMainWindowLoad` hook.

```ts
async function onMainWindowLoad(
  { window }: { window: Window },
  reason: integer,
): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `window` | `Window` | Yes | The Zotero main window that loaded. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Unused. |

**Returns:** `Promise<void>` — resolves when the TypeScript hook resolves.

**Throws:** None — the optional chaining (`Zotero.__addonInstance__?.…`) short-circuits to `undefined` if the singleton has been torn down.

`bootstrap.js:37-39`. This forwards to `hooks.onMainWindowLoad(window)` with optional chaining. The optional chaining matters during shutdown: if the global has already been deleted by `onShutdown` (`hooks.ts:60`), a late window event must not throw.

### onMainWindowUnload

Forwards a main-window unload event from Zotero to the TypeScript-side `onMainWindowUnload` hook.

```ts
async function onMainWindowUnload(
  { window }: { window: Window },
  reason: integer,
): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `window` | `Window` | Yes | The Zotero main window that unloaded. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Unused. |

**Returns:** `Promise<void>` — resolves when the TypeScript hook resolves.

**Throws:** None — optional chaining guards a missing singleton.

`bootstrap.js:41-43`. As with `onMainWindowLoad`, the optional chaining (`Zotero.__addonInstance__?.…`) ensures a late event after `onShutdown` does not throw.

### shutdown

Called by Zotero when the add-on is disabled, uninstalled, or upgraded, or when Zotero itself is quitting. Skips cleanup on `APP_SHUTDOWN`, otherwise tears down the TypeScript side and releases the chrome registration.

```ts
async function shutdown(
  { id, version, resourceURI, rootURI }: AddonData,
  reason: integer,
): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | Yes | Add-on ID. Unused. |
| `version` | `string` | Yes | Add-on version. Unused. |
| `resourceURI` | `string` | Yes | Add-on resource URI. Unused. |
| `rootURI` | `string` | Yes | Root URI of the add-on. Unused. |
| `reason` | `integer` | Yes | Mozilla bootstrap reason code. Compared against the in-scope `APP_SHUTDOWN` constant. |

**Returns:** `Promise<void>` — resolves once teardown is complete (or immediately on `APP_SHUTDOWN`).

**Throws:** Propagates any rejection from `Zotero.__addonInstance__?.hooks.onShutdown()`. `chromeHandle.destruct()` is best-effort and not expected to throw.

`bootstrap.js:45-56`:

```js
if (reason === APP_SHUTDOWN) {
  return;
}
await Zotero.__addonInstance__?.hooks.onShutdown();
if (chromeHandle) {
  chromeHandle.destruct();
  chromeHandle = null;
}
```

**Design decision — early return on `APP_SHUTDOWN`:** When Zotero itself is quitting, the entire process is going away and the chrome registration will be torn down with it. Calling `hooks.onShutdown()` in that case is wasteful and, historically, has caused dead-object errors when touching `Zotero.*` during quit. The convention (from Make It Red) is therefore to skip cleanup when `reason === APP_SHUTDOWN` and only run it for disable/uninstall/upgrade reasons. `APP_SHUTDOWN` is a Mozilla-defined constant in scope of the bootstrap.

`chromeHandle.destruct()` releases the chrome registration; setting the handle to `null` makes a second `shutdown` call idempotent.

## `src/index.ts` — sandbox initialization

`index.ts` is the first TypeScript file executed inside the sandbox. Its job is narrow: create the singleton `Addon` instance, expose it as `Zotero.SmartOrganizer`, and define a couple of globals.

```ts
const basicTool = new BasicTool();                       // index.ts:5

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}
```

**Idempotency guard (line 8):** The block is wrapped in `if (!basicTool.getGlobal("Zotero")[config.addonInstance])`. If the sandbox is ever re-entered (e.g. the bundle is loaded twice during development with `zotero-plugin serve`'s hot reload), the singleton is preserved rather than replaced. This keeps `addon.data` (which holds live toolkit registrations and the prefs window reference) intact across reloads.

The two `@ts-expect-error` comments acknowledge that `Zotero.SmartOrganizer` is not in `@types/zotero`; suppressing them is preferable to maintaining a custom `.d.ts` augmentation for a single property.

### defineGlobal

Exposes a name on the sandbox global as a lazy getter, either proxying to a host global via `basicTool.getGlobal` or returning the value produced by a supplied getter.

```ts
function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | Yes | The global name to define on `_globalThis`. |
| `getter` | `() => any` | No | Optional factory returning the value to expose. When omitted, the single-arg overload proxies to `basicTool.getGlobal(name)`. |

**Returns:** `void` — installs a getter on `_globalThis`.

**Throws:** None.

`defineGlobal` exposes a name on the sandbox global as a lazy getter. The single-arg overload (used implicitly for `Zotero`, `Services`, etc.) proxies to `basicTool.getGlobal(name)`, which fetches the real host object on first access. The two-arg overload (line 10-12) is used for `ztoolkit`, where the value is `_globalThis.addon.data.ztoolkit` — i.e. the toolkit instance owned by the singleton. Making it a getter rather than a plain assignment means `addon.data.ztoolkit` can be replaced (and is — see `hooks.ts:41`) and consumers reading `ztoolkit` always see the current instance.

## `src/addon.ts` — the `Addon` singleton

`Addon` is a plain class that holds all plugin-wide mutable state and the hooks table.

```ts
class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: { current: any };
    prefs?: { window: Window; columns: ...; rows: ... };
    dialog?: DialogHelper;
  };
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}
```

### `data` fields

| Field          | Type                                  | Purpose                                                                 |
|----------------|---------------------------------------|-------------------------------------------------------------------------|
| `alive`        | `boolean`                             | Set to `false` in `onShutdown` (`hooks.ts:58`). Lets long-running async paths bail out if the plugin was disabled mid-flight. |
| `config`       | `typeof config`                       | The `package.json.config` object, available without re-importing.      |
| `env`          | `"development" \| "production"`       | Filled from the build-time `__env__` global (defined by `zotero-plugin-scaffold`'s `build.js`). Drives logging in `ztoolkit.ts:20-22`. |
| `initialized`  | `boolean`                             | Set to `true` at the end of `onStartup` (`hooks.ts:37`). External test scaffolds poll this to know the plugin is ready. |
| `ztoolkit`     | `ZToolkit`                            | The `ZoteroToolkit` instance. Reassigned on every `onMainWindowLoad` (`hooks.ts:41`). |
| `locale`       | `{ current: any }`                    | Set by `initLocale()` (not shown). Holds the active locale bundle.     |
| `prefs`        | `{ window, columns, rows }`           | The preference pane's live state. `window` is set in `registerPrefsScripts` (`preferenceScript.ts:34-40`); `columns`/`rows` are declared but populated elsewhere. |
| `dialog`       | `DialogHelper`                        | Optional `zotero-plugin-toolkit` dialog helper. Not used by the lifecycle path. |

### `hooks` and `api`

`this.hooks = hooks` makes the hook table reachable as `Zotero.SmartOrganizer.hooks`, which is exactly how `bootstrap.js` calls it. `this.api = {}` is a placeholder for an externally consumable API surface; the plugin does not currently populate it.

### `__env__`

`__env__` is not a TypeScript built-in — it is a global injected by the build (`zotero-plugin-scaffold`'s `build.js`), whose value is `"development"` or `"production"`. The same global is read in `ztoolkit.ts:18`.

## `src/hooks.ts` — lifecycle hooks

`hooks.ts` is the dispatcher for all lifecycle events. The file's own header comment at the bottom (lines 78-80) states the guiding principle:

> Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks. Otherwise the code would be hard to read and maintain.

Accordingly, each hook delegates to a dedicated module (`preferenceScript`, `libraryReader`, `organizerUI`).

### Constants

```ts
const DEBUG_MENU_ID = `${config.addonRef}-read-library`;   // hooks.ts:19
const ORGANIZE_MENU_ID = `${config.addonRef}-organize`;    // hooks.ts:20
```

| Name | Value | Description |
|------|-------|-------------|
| `DEBUG_MENU_ID` | `"smartorganizer-read-library"` | Menu ID for the "Read Library (debug)" Tools menu item. |
| `ORGANIZE_MENU_ID` | `"smartorganizer-organize"` | Menu ID for the "Organize Library" Tools menu item. |

The menu IDs are namespaced with `addonRef` (`smartorganizer-read-library`, `smartorganizer-organize`) so they cannot collide with other plugins' menus and so they can be unregistered by exact ID in `onMainWindowUnload` (lines 51-52).

### onStartup

Dispatches the plugin's startup sequence: waits for Zotero readiness, initializes locale, registers the preference pane, sets up each existing main window, and marks the plugin initialized.

```ts
async function onStartup(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. |

**Returns:** `Promise<void>` — resolves once `addon.data.initialized` has been set to `true`.

**Throws:** Propagates rejections from `Zotero.initializationPromise` / `unlockPromise` / `uiReadyPromise`, `initLocale()`, `registerPrefs()`, or `onMainWindowLoad(win)`.

```ts
await Promise.all([
  Zotero.initializationPromise,
  Zotero.unlockPromise,
  Zotero.uiReadyPromise,
]);
initLocale();
await registerPrefs();
await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));
addon.data.initialized = true;
```

**Waiting on three Zotero promises before doing anything** is a deliberate defensive choice. `Zotero.initializationPromise` resolves when the data layer is up, `Zotero.unlockPromise` when the DB is writable, and `Zotero.uiReadyPromise` when the main UI is built. Calling `Zotero.PreferencePanes.register` or registering menus before these resolve can race with Zotero's own startup and either throw or silently no-op. Awaiting all three in parallel avoids serializing startup.

`initLocale()` loads the FTL string bundle so the menu labels and the preference pane title resolve correctly.

`registerPrefs()` registers the preference pane (see below). Awaiting it means a slow pane registration will block `onStartup` from proceeding to window setup; this is intentional — if the pane fails to register we want the rejection to surface here, not later.

`Promise.all(Zotero.getMainWindows().map(...))` calls `onMainWindowLoad` for every already-open main window. This is the bridge between Zotero's "windows that exist at startup" and the per-window hook. (On a normal launch there is exactly one main window; the loop is for robustness when Zotero restores a multi-window session.)

Finally `addon.data.initialized = true` is the readiness flag.

### onMainWindowLoad

Sets up a single main window: re-creates the per-window toolkit, loads the Fluent locale file, and registers the Tools menu items.

```ts
async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `_ZoteroTypes.MainWindow` | Yes | The Zotero main window that loaded. |

**Returns:** `Promise<void>` — resolves once the toolkit, FTL, and menus are in place.

**Throws:** Propagates any error from `createZToolkit()`, `MozXULElement.insertFTLIfNeeded`, or `registerDebugMenu()`.

```ts
addon.data.ztoolkit = createZToolkit();
win.MozXULElement.insertFTLIfNeeded(
  `${addon.data.config.addonRef}-mainWindow.ftl`,
);
registerDebugMenu();
```

- **Re-create the toolkit.** `createZToolkit()` returns a fresh `ZoteroToolkit` each call. Reassigning `addon.data.ztoolkit` here means each window gets a clean toolkit whose registrations can be torn down independently. Because `index.ts` exposes `ztoolkit` as a getter over `addon.data.ztoolkit`, every consumer automatically sees the new instance.
- **Load the FTL file.** `MozXULElement.insertFTLIfNeeded("smartorganizer-mainWindow.ftl")` registers the Fluent locale file for the main window. "IfNeeded" means it is a no-op on subsequent calls, so calling it once per window load is safe. The file name uses `addonRef`, matching the convention from `bootstrap.js`.
- **Register the menus** via `registerDebugMenu()`.

### onMainWindowUnload

Tears down a single main window: unregisters the Tools menu items by ID and drops all toolkit-registered UI elements.

```ts
async function onMainWindowUnload(_win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `_win` | `Window` | Yes | The Zotero main window that unloaded. Intentionally unused. |

**Returns:** `Promise<void>` — resolves once teardown is complete.

**Throws:** Propagates any error from `Zotero.MenuManager.unregisterMenu` or `ztoolkit.unregisterAll()`.

```ts
Zotero.MenuManager.unregisterMenu(DEBUG_MENU_ID);
Zotero.MenuManager.unregisterMenu(ORGANIZE_MENU_ID);
ztoolkit.unregisterAll();
```

Per-window teardown unregisters the two Tools menu items by ID and calls `ztoolkit.unregisterAll()` to drop any toolkit-registered UI elements, observers, etc. The `_win` parameter is intentionally unused — there is exactly one set of menus per window, identified by the constant IDs.

### onShutdown

Tears down the entire plugin: unregisters toolkit state, marks the plugin not alive, and removes `Zotero.SmartOrganizer` so subsequent optional-chained calls short-circuit.

```ts
function onShutdown(): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. |

**Returns:** `void`.

**Throws:** None — `delete` on the `Zotero` global does not throw.

```ts
ztoolkit.unregisterAll();
addon.data.alive = false;
// @ts-expect-error - Plugin instance is not typed
delete Zotero[addon.data.config.addonInstance];
```

This is the counterpart to `index.ts:14`. After unregistering everything and flipping `alive` to `false`, it `delete`s `Zotero.SmartOrganizer`. This is what makes `Zotero.__addonInstance__?.…` in `bootstrap.js` become `undefined` on subsequent (post-shutdown) window events, so the optional chaining short-circuits cleanly.

### onPrefsEvent

Dispatcher for preference-pane events. Currently handles only `"load"` by wiring up the pane's controls.

```ts
async function onPrefsEvent(
  type: string,
  data: { [key: string]: any },
): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | `string` | Yes | Event type. Only `"load"` is handled today. |
| `data` | `{ [key: string]: any }` | Yes | Event payload. For `"load"`, must contain `window: Window`. |

**Returns:** `Promise<void>` — resolves once the load handler finishes (or immediately for unknown event types).

**Throws:** Propagates any error from `registerPrefsScripts(data.window)`.

```ts
switch (type) {
  case "load":
    registerPrefsScripts(data.window);
    break;
  default:
    return;
}
```

A tiny dispatcher invoked from `preferences.xhtml`'s `onload` (which calls `Zotero.SmartOrganizer.hooks.onPrefsEvent("load", { window })`). Only `"load"` is handled today; the `default: return` keeps the dispatcher extensible — new event types can be added without touching the XHTML.

### registerDebugMenu

Registers two menu items under **Tools** in the main menubar.

```ts
function registerDebugMenu(): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. |

**Returns:** `void`.

**Throws:** Propagates any error from `Zotero.MenuManager.registerMenu`.

```ts
Zotero.MenuManager.registerMenu({
  menuID: DEBUG_MENU_ID,
  pluginID: config.addonID,
  target: "main/menubar/tools",
  menus: [{
    menuType: "menuitem",
    l10nID: `${config.addonRef}-menu-readLibrary`,
    onCommand: () => { void runDebugReadLibrary(); },
  }],
});

Zotero.MenuManager.registerMenu({
  menuID: ORGANIZE_MENU_ID,
  pluginID: config.addonID,
  target: "main/menubar/tools",
  menus: [{
    menuType: "menuitem",
    l10nID: `${config.addonRef}-menu-organize`,
    onCommand: () => { void openReviewWindow(); },
  }],
});
```

- **`target: "main/menubar/tools"`** places both items under the Tools menu.
- **`pluginID: config.addonID`** associates the menus with this add-on so Zotero can attribute and (in some hosts) auto-clean them.
- **`l10nID`** uses the Fluent string IDs `smartorganizer-menu-readLibrary` and `smartorganizer-menu-organize`, defined in the FTL bundle loaded in `onMainWindowLoad`.
- The two `onCommand` handlers fire-and-forget with `void`:
  - `runDebugReadLibrary()` (Gate 2's read-only diagnostic — `hooks.ts:127-164`) calls `readLibrary()` + `summarizeLibrary()`, logs the summary via `Zotero.debug`, and shows a `Zotero.ProgressWindow`. It performs **no writes and no LLM calls**, which is what makes it a safe diagnostic.
  - `openReviewWindow()` (Gate 4's entry point, in `organizerUI.ts:69`) opens the chrome:// review window and starts plan generation.

The comment block at lines 84-90 documents the gate history: the "Organize Library" item replaced Gate 3's "Run Categorization (debug)" item, and the read-library diagnostic was retained verbatim from Gate 2.

### runDebugReadLibrary

Runs the read-only library reader and reports a summary via `Zotero.debug` and a `Zotero.ProgressWindow`. Performs no writes and no LLM calls.

```ts
async function runDebugReadLibrary(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. |

**Returns:** `Promise<void>` — resolves once the progress window's close timer has started.

**Throws:** None — internal errors are caught and surfaced via `Zotero.debug` and the progress window.

A self-contained diagnostic. Notable details:

- Uses `new Zotero.ProgressWindow()` (line 128) to surface progress in the Zotero status area.
- Wraps `readLibrary()` + `summarizeLibrary()` in `try/catch`; on error it logs to `Zotero.debug`, sets the progress window description to the error message, and starts an 8-second close timer (lines 139-144).
- On success it formats a multi-line summary (total items, items with abstract/DOI/tag/attachment, unfiled count, top 5 collection paths) and logs each line individually so each appears as a separate `[SmartOrganizer]` debug entry (lines 146-160).
- The progress window closes after 4 seconds on success (line 163).

### Default export

```ts
export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
```

The hook table is the only export. `addon.ts:37` assigns it to `this.hooks`, making every hook reachable as `Zotero.SmartOrganizer.hooks.<name>`.

## Preference pane registration

Two functions in `src/modules/preferenceScript.ts` cooperate to register the pane.

### registerPrefs

Registers the preference pane with Zotero. Called once at startup.

```ts
export async function registerPrefs(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. Reads `rootURI` from the sandbox global. |

**Returns:** `Promise<void>` — resolves once `Zotero.PreferencePanes.register` has resolved.

**Throws:** Propagates any rejection from `Zotero.PreferencePanes.register` (duplicate pane ID, `resolveURI` failure, etc.).

```ts
await Zotero.PreferencePanes.register({
  pluginID: config.addonID,
  src: rootURI + "content/preferences.xhtml",
  label: getString("prefs-title"),
  image: `chrome://${REF}/content/icons/favicon.png`,
});
```

- `src` uses the global `rootURI` (injected by `bootstrap.js` into the sandbox) — *not* a `chrome://` URL. Zotero's preference pane loader expects a real filesystem path here, so `rootURI` is correct.
- `image` *does* use `chrome://smartorganizer/content/icons/favicon.png` — by this point `bootstrap.js` has registered the chrome URL, so the icon resolves.
- The doc comment (lines 13-19) explains why the function is `async` and awaited: `Zotero.PreferencePanes.register` returns a promise, and awaiting surfaces rejections (duplicate pane ID, `resolveURI` failure) to `onStartup`'s call site instead of becoming unhandled rejections. This is a deliberate fix for a class of silent failures.

### registerPrefsScripts

Wires up the preference pane controls when it loads. Called from `preferences.xhtml`'s `onload` via `hooks.onPrefsEvent("load")`.

```ts
export async function registerPrefsScripts(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The preference pane's window. Stored on `addon.data.prefs.window`. |

**Returns:** `Promise<void>` — resolves once all controls are wired up.

**Throws:** None expected; failures reading/writing prefs are caught and logged via `Zotero.debug`.

It:

1. Stores the pane's `window` on `addon.data.prefs` (lines 34-40) so other code can reach it later.
2. Wires up nine preference-backed controls (`endpoint`, `apiKey`, `model`, `provider`, `maxTokens`, `timeoutSeconds`, `reasoningEffort`, `taxonomySystemPrompt`, `classificationSystemPrompt`). For each, it reads the current pref value (defaulting to `""`), sets the control, and registers four event listeners (`command`, `change`, `input`, `blur`) that persist the value. The multi-event listener pattern (comment at line 79) is a cross-platform robustness measure — different XUL/HTML controls fire different events on different platforms.
3. For the two custom-prompt textareas, if the stored pref is empty it pre-fills the textarea with the default prompt from `promptBuilder` (lines 89-108). The comment at lines 103-106 explains the `<html:textarea>` migration: setting `.value` displays the default and keeps the field editable; no `value=` attribute is needed for an HTML textarea.
4. Wires the "Test connection" button to `testConnection()`, force-persisting all fields first (lines 116-141) so a test always uses the latest typed values even if the user did not blur the field.

### getControlValue

Reads the current value of a preference-pane control. Uses `el.localName` (always lowercase, namespace-agnostic) rather than `el.tagName` to sidestep casing/prefix differences between Zotero versions.

```ts
function getControlValue(el: any): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `el` | `any` | Yes | The control element (e.g. `<menulist>`, `<menu>`, `<html:textarea>`). |

**Returns:** `string` — the control's current value (coerced to a string, `""` if missing).

**Throws:** None.

`getControlValue` (preferenceScript.ts:147-155) handles `<menulist>`, `<menu>`, and `<html:textarea>` uniformly via `localName`, which makes the same code work across Zotero versions and namespace prefixes.

### setControlValue

Sets the value of a preference-pane control. As with `getControlValue`, uses `el.localName` rather than `el.tagName` for cross-version robustness.

```ts
function setControlValue(el: any, value: string): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `el` | `any` | Yes | The control element to update. |
| `value` | `string` | Yes | The value to set. |

**Returns:** `void`.

**Throws:** None.

`setControlValue` (preferenceScript.ts:157-163) is the symmetric writer to `getControlValue`. Both use `el.localName` rather than `el.tagName` (comment at line 150). `localName` is always lowercase and namespace-agnostic, which sidesteps casing/prefix differences between Zotero versions and makes the same code work for `<menulist>`, `<menu>`, and `<html:textarea>`.

## `chrome://` URL registration and why `openDialog` must use `chrome://`

`bootstrap.js:17-19` registers a single chrome package:

```js
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "__addonRef__", rootURI + "content/"],
]);
```

After substitution this maps:

```
chrome://smartorganizer/content/<path>   →   <rootURI>/content/<path>
```

This mapping is what makes `chrome://${config.addonRef}/content/...` URLs work in:

- The preference pane icon: `preferenceScript.ts:25`.
- The toolkit progress-window icon: `ztoolkit.ts:30` (`chrome://smartorganizer/content/icons/favicon.png`).
- The review window: `organizerUI.ts:84` — `chrome://${config.addonRef}/content/organizer.xhtml`.

### Why `openDialog` uses `chrome://` and not `file://`

`organizerUI.ts:82-89` opens the review window like this:

```ts
const mainWin = Zotero.getMainWindow();
const reviewUrl = `chrome://${config.addonRef}/content/organizer.xhtml`;
const win = mainWin.openDialog(
  reviewUrl,
  "smartorganizer-review",
  "chrome,dialog=no,centerscreen,resizable=yes,width=900,height=640",
);
```

The comment at line 83 states the rule outright: *use the chrome:// URL registered in bootstrap.js, not the `file://` rootURI*. There are three concrete reasons:

1. **`file://` URLs break on installed builds.** During `zotero-plugin serve` development the add-on lives in a real directory and `file://` would happen to work. But once the plugin is packaged as an XPI and installed, the on-disk path no longer exists — the XPI is unzipped into Zotero's profile extensions directory or read directly from the archive. The `chrome://` mapping abstracts over both cases because `aomStartup.registerChrome` resolves the package root to wherever Zotero actually stored the add-on. Hard-coding `file://` would work in dev and silently fail in production.

2. **Chrome registration grants the right principal.** A window opened from a `chrome://` URL runs with chrome (system) privileges and the `chrome://` origin, which is what allows it to access `Components`, `Services`, and the privileged `Zotero` object. A window opened from `file://` runs with a content principal and a `file://` origin, which is sandboxed; it cannot touch `Components.classes`, cannot call privileged Zotero APIs, and cannot load the FTL bundle. The review window needs to call `applyPlan`, `revertFromSnapshot`, etc., which require the chrome principal.

3. **Relative resource resolution.** The review XHTML loads its own scripts, icons, and FTL via relative URLs. Under `chrome://smartorganizer/content/organizer.xhtml` those resolve against the same chrome package. Under `file://` they would resolve against the filesystem — and again break on packaged installs.

### The chrome-scope gotcha and how `openReviewWindow` works around it

`organizerUI.ts:93-107` contains a CRITICAL comment:

> The XHTML's `onload="Zotero.SmartOrganizer.hooks..."` does NOT work because the chrome:// window runs in a different scope where the plugin's `Zotero.SmartOrganizer` is not defined. Instead, we wait for the window to load and initialize it directly from here (where we have access to Zotero).

The chrome window opened by `openDialog` runs in its own scope. The bootstrap script registered `Zotero.SmartOrganizer` on the *main* window's `Zotero` global; the new chrome window has its own `Zotero` (and its own `window`) where the plugin's instance is not attached. So the XHTML cannot call back into `Zotero.SmartOrganizer.hooks` directly. The workaround is to keep all initialization on the caller side:

```ts
await new Promise<void>((resolve) => {
  if (win.document.readyState === "complete") {
    resolve();
  } else {
    win.addEventListener("load", () => resolve(), { once: true });
  }
});
initOrganizerUI(win);
```

The caller (`openReviewWindow`, which runs in the plugin's bootstrap context and therefore *does* see `Zotero.SmartOrganizer`) waits for the window's `load` event and then calls `initOrganizerUI(win)` directly. This is also why the file-level comment in `hooks.ts:14-17` notes that there is deliberately **no `onOrganizerLoad` hook** — the chrome scope does not expose `Zotero.SmartOrganizer`, so a hook there would be unreachable.

### openReviewWindow

Opens the review window and starts generating a plan. The window opens immediately in a "generating" state with a live LLM activity log; when the plan is ready, the window swaps to the plan view (taxonomy tree + items). Called from the "Smart Organizer: Organize Library" menu item.

```ts
export async function openReviewWindow(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. Reads window state from the `organizerUI` module-level `state`. |

**Returns:** `Promise<void>` — resolves once the window's `load` event has fired (or immediately if it was already complete) and `initOrganizerUI(win)` has been invoked.

**Throws:** Propagates any error from `Zotero.getMainWindow().openDialog` or from `initOrganizerUI(win)`.

Source: `organizerUI.ts:69`. The function resets module-level `state` for a fresh generation, reuses an already-open window if one exists, otherwise opens a new chrome:// dialog and waits for its `load` event before calling `initOrganizerUI(win)` in the plugin context.

### initOrganizerUI

Initializes the review window after its XHTML loads. Wires up the button handlers and starts generating the plan. Called from `openReviewWindow` (not from a hook — see the chrome-scope gotcha above).

```ts
export function initOrganizerUI(win: Window): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The review window to initialize. |

**Returns:** `void`.

**Throws:** Propagates any error from button wiring or plan generation kickoff.

Source: `organizerUI.ts:294`. The doc comment notes it is "Called from `hooks.onOrganizerLoad`" in the original scaffold, but the lifecycle doc above explains why it is in fact called directly from `openReviewWindow` rather than from a hook.

## `src/utils/ztoolkit.ts` — toolkit factory

### createZToolkit

Constructs and initializes a fresh `ZoteroToolkit` instance for the current window.

```ts
function createZToolkit(): ZoteroToolkit
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. |

**Returns:** `ZoteroToolkit` — a configured toolkit instance, ready for UI/progress-window registration.

**Throws:** Propagates any error from `new ZoteroToolkit()` or `initZToolkit`.

```ts
function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}
```

### initZToolkit

Configures a `ZoteroToolkit` instance: log prefix, console gating, dev-only element logs, plugin ID, and the default progress-window icon.

```ts
function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `_ztoolkit` | `ZoteroToolkit` | Yes | The toolkit instance to configure in place. |

**Returns:** `void`.

**Throws:** None.

`initZToolkit` (lines 17-32) configures the toolkit:

- `basicOptions.log.prefix = "[${config.addonName}]"` — every log line is prefixed `[Zotero Smart Organizer]`.
- `basicOptions.log.disableConsole = env === "production"` — console logging is silenced in production builds to avoid noise; `Zotero.debug` still receives logs.
- `UI.basicOptions.ui.enableElementJSONLog` / `enableElementDOMLog` are gated on `__env__ === "development"` — these verbose element logs are dev-only.
- `basicOptions.api.pluginID = config.addonID` — identifies the plugin to the toolkit's API surface.
- `ProgressWindow.setIconURI("default", "chrome://${config.addonRef}/content/icons/favicon.png")` — sets the default progress-window icon via the chrome URL registered in `bootstrap.js`. This must use `chrome://` for the same reason `openDialog` does: the icon needs to resolve on packaged installs.

The commented-out `MyToolkit` class (lines 37-48) is a template for tree-shaking unused toolkit modules; the plugin currently uses the full `ZoteroToolkit` and leaves it commented.

## Library reader helpers (used by the debug menu)

The `runDebugReadLibrary` diagnostic delegates to two functions re-exported from `src/modules/libraryReader.ts` (which itself re-exports the pure model from `src/modules/libraryModel.ts`).

### readLibrary

Reads all regular, non-trashed items from the user library (libraryID `1`) and maps them to the `LibraryItem` in-memory model. Missing metadata fields are returned as empty strings; an item in no collections has `collectionPaths: []`.

```ts
export async function readLibrary(): Promise<LibraryItem[]>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| _(none)_ | — | — | No parameters. Reads from the Zotero user library (`libraryID = 1`). |

**Returns:** `Promise<LibraryItem[]>` — the filtered, mapped library items (regular items only, attachments and notes excluded).

**Throws:** Propagates any error from `Zotero.Items.getAll` or item field access.

Source: `libraryReader.ts:55`.

### summarizeLibrary

Computes summary statistics from a `LibraryItem[]`. Pure function over the in-memory model — no Zotero globals. Used by the debug entry point so the same logic is testable without a Zotero sandbox.

```ts
export function summarizeLibrary(items: LibraryItem[]): LibrarySummary
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The items to summarize. |

**Returns:** `LibrarySummary` — total count, counts of items with abstract/DOI/tag/attachment, unfiled count, and the top 5 collection paths by item count.

**Throws:** None.

Source: `libraryModel.ts:65`.

### serializeLibrary

Produces a stable JSON serialization (object keys sorted alphabetically, recursively) of the item array. This is what Gate 3 consumes. Does not write to disk.

```ts
export function serializeLibrary(items: LibraryItem[]): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | `LibraryItem[]` | Yes | The items to serialize. |

**Returns:** `string` — pretty-printed JSON with sorted object keys (arrays preserved in original order).

**Throws:** None.

Source: `libraryModel.ts:30`.

## The full lifecycle, end to end

1. **Install/enable.** Zotero calls `bootstrap.js:install` (no-op) and then `bootstrap.js:startup`.
2. **Chrome registration.** `startup` calls `aomStartup.registerChrome` to map `chrome://smartorganizer/content/` → the add-on's `content/` directory.
3. **Sandbox load.** `loadSubScript` runs the compiled `src/index.ts`, which — guarded by the `if (!Zotero.SmartOrganizer)` check — constructs the `Addon` singleton and assigns it to `Zotero.SmartOrganizer`.
4. **Hook dispatch.** `bootstrap.js:startup` awaits `Zotero.SmartOrganizer.hooks.onStartup()`.
5. **Startup awaits Zotero.** `onStartup` waits on the three Zotero readiness promises, initializes locale, and registers the preference pane.
6. **Per-window setup.** For each main window, `onMainWindowLoad` re-creates the toolkit, loads the FTL bundle, and registers the two Tools menu items.
7. **Ready.** `addon.data.initialized = true`.
8. **User interaction.** The user picks "Smart Organizer: Organize Library" from Tools, which calls `openReviewWindow()`. The window opens at the `chrome://smartorganizer/content/organizer.xhtml` URL (chrome principal, packaged-install-safe) and is initialized from the plugin context after its `load` event fires.
9. **Disable/uninstall/upgrade.** Zotero calls `bootstrap.js:shutdown`. If `reason === APP_SHUTDOWN`, it returns immediately (process is dying). Otherwise it awaits `hooks.onShutdown()`, which unregisters everything, sets `addon.data.alive = false`, and `delete`s `Zotero.SmartOrganizer`. `bootstrap.js` then destructs `chromeHandle`.

## Extending the lifecycle

- **Add a new menu item.** Add another `Zotero.MenuManager.registerMenu({ menuID, pluginID, target, menus })` call inside `registerDebugMenu()` (`hooks.ts:91`). Use a new constant ID namespaced with `config.addonRef` and add the `l10nID` to the FTL bundle. Remember to add a matching `unregisterMenu` in `onMainWindowUnload`.
- **Add a new lifecycle stage.** Add the function to `hooks.ts` and to the default export at line 166. Call it from `bootstrap.js` (e.g. `Zotero.__addonInstance__?.hooks.onNewStage(...)`), mirroring the optional-chaining pattern used for `onMainWindowLoad`.
- **Add a new preference.** Add the field to the `fields` array in `registerPrefsScripts` (`preferenceScript.ts:44`) and the corresponding `<pref>` element in `preferences.xhtml`. The four-listener persist pattern will pick it up automatically.
- **Add a new chrome package.** Add another `["resource", ...]` or `["locale", ...]` entry to the `registerChrome` array in `bootstrap.js:17`. Use the new `chrome://` URL from TypeScript; do not construct `file://` URLs.
