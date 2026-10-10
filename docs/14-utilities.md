# Utility Modules

The `src/utils/` directory holds a set of small, leaf-level helpers that the rest of the Smart Organizer plugin builds on. They are not large — most are under 50 lines — but each one encodes a specific Zotero 7 / Firefox-sandbox idiom that is easy to get wrong: HTML-namespace element creation in a XUL document, Fluent-locale string resolution with attribute branches, pref reads/writes scoped under the plugin's pref prefix, liveness checks for chrome `Window` objects, and the `ZoteroToolkit` factory that wires the plugin's logger and ProgressWindow icon.

These modules have no internal dependencies on the rest of the plugin's business logic; they only depend on the add-on bootstrap globals (`addon`, `ztoolkit`, `__env__`, `Zotero`, `Components`) and on `package.json`-derived `config`. That makes them the right place to start reading when you want to understand "how does this plugin talk to Zotero?".

| File | Exports | Purpose |
| --- | --- | --- |
| `src/utils/domHelpers.ts` | `HTML_NS`, `el()` | Build HTML-namespace display nodes inside a XUL document. |
| `src/utils/locale.ts` | `initLocale`, `getString`, `getLocaleID` | Load the Fluent `.ftl` catalog and resolve message IDs to localized strings. |
| `src/utils/prefs.ts` | `getPref`, `setPref`, `clearPref` | Typed, prefix-scoped wrappers over `Zotero.Prefs`. |
| `src/utils/window.ts` | `isWindowAlive` | Detect whether a chrome `Window` is still usable. |
| `src/utils/ztoolkit.ts` | `createZToolkit` (+ `MyToolkit`) | Construct and configure the shared `ZoteroToolkit` instance. |

---

## `domHelpers.ts`

**Path:** `src/utils/domHelpers.ts:1-43`

### Why this module exists

The organizer UI is authored as `addon/content/organizer.xhtml`, and that document declares the XUL default namespace:

```
xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
```

A naïve `doc.createElement("label")` against such a document does **not** produce a XUL `<label>`. In a namespaced XML document, `createElement` resolves the tag in the *default* namespace, so you get an HTML-namespace `HTMLLabelElement`. The HTML `<label>` element does not render its text through the `.value` property — only through `.textContent`/child content — so a XUL-style `label.value = "..."` produces an invisible, zero-size box even though the DOM tree looks structurally fine. The module header (`domHelpers.ts:5-13`) calls this out as the documented Zotero 7/9/10 migration: `createElement()`/`createElementNS()` must be replaced with `createXULElement()` for genuine XUL elements, **or** — for plain display text — HTML-namespace elements with `textContent` should be used.

This module implements the second half of that guidance. It mirrors the `llm-for-zotero` plugin's `src/utils/domHelpers.ts` (cited at `domHelpers.ts:15`): create HTML-namespace `div`/`span` elements and set `.textContent`. `.value` is left for real HTML form controls (`<input>`, `<textarea>`, `<select>`), where it is the correct property.

### Exports

#### `HTML_NS`

```ts
export const HTML_NS = "http://www.w3.org/1999/xhtml"; // domHelpers.ts:21
```

The XHTML namespace URI. Used as the first argument to `doc.createElementNS` so that the created node is unambiguously an HTML-namespace element regardless of the owner document's default namespace.

### `el`

Creates an HTML-namespace element owned by `doc`, optionally applying an inline style string and/or text content.

```ts
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K]; // domHelpers.ts:32-42
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `doc` | `Document` | Yes | The owner document — in practice, the XUL document of the organizer window. |
| `tag` | `K extends keyof HTMLElementTagNameMap` | Yes | HTML tag name, e.g. `"div"`, `"span"`. The generic `K` preserves the precise element type in the return value (e.g. `HTMLDivElement`), so callers get typed access to element-specific members. |
| `style` | `string` | No | Inline CSS. Applied via `node.setAttribute("style", style)` — *not* `node.style.cssText` — so the style round-trips through the attribute and survives serialization. An empty/undefined value skips the attribute entirely. |
| `text` | `string` | No | Text content. Set via `node.textContent = text`. The check is `text !== undefined` (not just truthiness), so an explicit `""` *will* clear the node's text. |

**Returns:** `HTMLElementTagNameMap[K]` — the created HTML-namespace element, typed to the specific tag.

**Throws:** None.

**Implementation** (`domHelpers.ts:38-41`)

```ts
const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
if (style) node.setAttribute("style", style);
if (text !== undefined) node.textContent = text;
return node;
```

The cast is necessary because `createElementNS` is typed to return `Element`, not the specific `HTMLElementTagNameMap[K]` the caller expects.

### Design decisions

- **HTML namespace, not XUL.** Deliberately uses `createElementNS(HTML_NS, ...)` instead of `doc.createXULElement()`. Display text needs no XUL semantics, and HTML elements styled with inline CSS give predictable cross-Zotero-version rendering. Genuine XUL widgets (`<button>`, `<checkbox>`, `<menupopup>`, …) should still be created with `createXULElement` elsewhere — this helper is for layout/text scaffolding only.
- **`setAttribute("style", …)` over `.style.cssText`.** Setting via the attribute is what makes the helper safe to call before the element is inserted into the document and keeps the style visible in DOM serialization/debugging.
- **`textContent`, never `.value`.** The `.value` path is what triggers the invisible-label bug described in the header. Using `textContent` is the fix.
- **No event-listener or class-list helpers.** The helper intentionally does the minimum. Callers attach listeners and classes via the returned element directly.

### How to extend

If you need a richer builder (children, attributes, event listeners), add a sibling helper rather than overloading `el()`. Keep `el()` as the single, predictable way to produce a styled text node. For genuine XUL widgets, do **not** route them through here — call `doc.createXULElement(tag)` at the call site so the namespace is unambiguous in the diff.

---

## `locale.ts`

**Path:** `src/utils/locale.ts:1-96`

This module wraps Mozilla's Fluent localization system (`Localization`, FTL files) so the rest of the plugin can resolve strings by logical message ID without worrying about the `addonRef-` prefix or the Fluent attribute-branch / args conventions.

### Imports

```ts
import { config } from "../../package.json";          // locale.ts:1
import { FluentMessageId } from "../../typings/i10n"; // locale.ts:2
```

`config.addonRef` (from `package.json`) is prepended to every message ID before lookup, so the same logical key (`"organizer.title"`) maps to the FTL key `smart-organizer-organizer.title`. `FluentMessageId` is the union of keys declared in `typings/i10n.d.ts` — the call-site type narrowing ensures a typo'd message ID is a compile-time error.

### `initLocale`

Constructs the `Localization` instance that backs all later `getString` calls and stores it on the add-on's global state.

```ts
function initLocale(): void; // locale.ts:9-18
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| *(none)* | — | — | — |

**Returns:** `void` — stores the constructed `Localization` on `addon.data.locale.current`.

**Throws:** None directly; may propagate from the `Localization` constructor if the catalog fails to load.

**Implementation**

```ts
const l10n = new (
  typeof Localization === "undefined"
    ? ztoolkit.getGlobal("Localization")
    : Localization
)([`${config.addonRef}-addon.ftl`], true);
addon.data.locale = { current: l10n };
```

Three things to note:

1. **`Localization` may not be a global.** In some Zotero sandbox contexts the `Localization` constructor is not on `globalThis`, so the code falls back to `ztoolkit.getGlobal("Localization")` (`locale.ts:11-13`). `ztoolkit.getGlobal` is the Zotero-Toolkit-provided bridge to chrome-privileged globals.
2. **The `.ftl` filename is `${addonRef}-addon.ftl`** and the second argument `true` enables synchronous formatting (`formatMessagesSync` is used later). The loaded catalog must ship at `addon/locale/*/addonRef-addon.ftl` for this to resolve anything.
3. The result is stored on `addon.data.locale.current`, which `_getString` reads lazily (`locale.ts:77`). `initLocale` must therefore run during bootstrap before any UI asks for a string.

### `getString` — public overload set

Resolves a Fluent message ID to a localized string, with optional attribute-branch and placeholder-args forms.

```ts
function getString(localString: FluentMessageId): string;
function getString(localString: FluentMessageId, branch: string): string;
function getString(
  localeString: FluentMessageId,
  options: { branch?: string | undefined; args?: Record<string, unknown> },
): string; // locale.ts:43-48
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `localString` / `localeString` | `FluentMessageId` | Yes | The logical Fluent message ID (without the `addonRef-` prefix — that is applied internally). |
| `branch` | `string` | No | Fluent attribute-branch name (e.g. `"tooltip"`). Selects an attribute on the message rather than its default value. |
| `options.branch` | `string \| undefined` | No | Equivalent to the `branch` overload argument; used in the options-object form. |
| `options.args` | `Record<string, unknown>` | No | Fluent placeholder values, used to fill `{ $name }` substitutions in the message. |

**Returns:** `string` — the resolved localized string, or the prefixed key itself as a fallback when the message or branch is missing.

**Throws:** `Error("Invalid arguments")` if called with anything other than 1 or 2 arguments, or with a 2-argument form whose second argument is neither a string nor an options object (dispatcher at `locale.ts:49-61`).

The runtime dispatcher is at `locale.ts:49-61`:

```ts
function getString(...inputs: any[]) {
  if (inputs.length === 1) {
    return _getString(inputs[0]);
  } else if (inputs.length === 2) {
    if (typeof inputs[1] === "string") {
      return _getString(inputs[0], { branch: inputs[1] });
    } else {
      return _getString(inputs[0], inputs[1]);
    }
  } else {
    throw new Error("Invalid arguments");
  }
}
```

Three call shapes are accepted:

| Call | Resolves to |
| --- | --- |
| `getString("organizer.title")` | default value branch of the message |
| `getString("organizer.title", "tooltip")` | the `.tooltip` attribute branch |
| `getString("organizer.title", { branch: "tooltip", args: { count: 2 } })` | attribute branch with Fluent placeholder filled |

The `any[]` dispatcher is the cost of giving callers three ergonomic overloads in TypeScript without runtime overhead — the public signatures are what show up in IDE autocomplete, the fourth implementation signature is the one that actually runs.

### `_getString` — internal resolver

Resolves a (prefixed) Fluent message ID to a string, applying the missing-pattern and missing-branch fallback policy.

```ts
function _getString(
  localeString: FluentMessageId,
  options: { branch?: string | undefined; args?: Record<string, unknown> } = {},
): string; // locale.ts:71-92
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `localeString` | `FluentMessageId` | Yes | The logical message ID. The `addonRef-` prefix is prepended internally before lookup. |
| `options.branch` | `string \| undefined` | No | If set and the message has `.attributes`, the attribute with this `name` is returned. |
| `options.args` | `Record<string, unknown>` | No | Fluent placeholder values forwarded to `formatMessagesSync`. |

**Returns:** `string` — the resolved value, attribute value, or (as fallback) the fully-prefixed Fluent id.

**Throws:** None. Missing patterns/attributes fall back to the prefixed id string rather than throwing.

**Step by step:**

1. Build the full Fluent id: `localStringWithPrefix = `${config.addonRef}-${localeString}`` (`locale.ts:75`).
2. Ask the live `Localization` for the resolved pattern, synchronously:
   ```ts
   const pattern = addon.data.locale?.current.formatMessagesSync([
     { id: localStringWithPrefix, args },
   ])[0] as Pattern;
   ```
   (`locale.ts:77-79`). `formatMessagesSync` returns one entry per requested id; we ask for one and grab index `0`.
3. **Fallback #1 — missing pattern.** If `pattern` is falsy (the id is not present in the loaded `.ftl`), return `localStringWithPrefix` (`locale.ts:81-83`). This means a missing translation surfaces as the *key itself* (`smart-organizer-organizer.title`) rather than `undefined`, so a missed string is visible in the UI rather than silently empty.
4. **Attribute-branch path.** If a `branch` was requested and the message has `.attributes`, find the attribute whose `name === branch` and return its `.value`; if no such attribute exists, fall back to the prefixed id again (`locale.ts:84-88`).
5. **Default path.** Return `pattern.value`, or — if `value` is itself null/empty — the prefixed id (`locale.ts:89-91`).

`Pattern` is the local interface at `locale.ts:63-69`:

```ts
interface Pattern {
  value: string | null;
  attributes: Array<{ name: string; value: string }> | null;
}
```

**Fields**

| Name | Type | Description |
| --- | --- | --- |
| `value` | `string \| null` | The default-branch formatted value of the Fluent message. |
| `attributes` | `Array<{ name: string; value: string }> \| null` | Attribute branches declared on the message (e.g. `.tooltip`), or `null` if none. |

It is a minimal structural projection of what `formatMessagesSync` returns; the cast at `locale.ts:79` is the boundary where the untyped Mozilla API enters typed code.

### `getLocaleID`

Returns the fully-qualified Fluent id (with the `addonRef-` prefix) for a logical message ID.

```ts
function getLocaleID(id: FluentMessageId): string; // locale.ts:94-96
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `FluentMessageId` | Yes | The logical message ID (e.g. `"organizer.title"`). |

**Returns:** `string` — the prefixed id (e.g. `"smart-organizer-organizer.title"`).

**Throws:** None.

Useful when you need to pass the id to an API that resolves Fluent strings itself (e.g. setting a XUL element's `data-l10n-id` attribute), as opposed to resolving it eagerly with `getString`.

### Design decisions & bugs

- **Three overloads via `any[]` dispatcher.** The public API is type-safe; the implementation deliberately uses `any[]` so the call-site overloads are the source of truth. Any caller passing the wrong shape gets a *compile-time* error from the public signatures, not a runtime one.
- **Fallback to the prefixed key, not to `""`.** This is a deliberate UX choice: a missing translation should be visible as a developer-visible string, not a blank widget. It also makes broken-translation bugs trivially greppable.
- **`formatMessagesSync` over `formatValuesSync`.** Sync access is required because the organizer window builds its DOM synchronously on open; `formatMessagesSync` (rather than `formatValuesSync`) is used because the attribute-branch path needs the structured `Pattern` (value + attributes), not just the formatted value.
- **`Localization` global may be undefined.** Falling back to `ztoolkit.getGlobal("Localization")` (`locale.ts:11-13`) is the sandbox-safe pattern — chrome-privileged constructors are not always on the same global as the add-on script.

### How to extend

- **Adding a new string:** add the key to `typings/i10n.d.ts` (so `FluentMessageId` knows about it), add the entry to every `addon/locale/*/addonRef-addon.ftl` file, then call `getString("your.key")`.
- **Adding a new branch** (e.g. `.tooltip`): no code change here — pass `getString("your.key", "tooltip")`. The branch must exist in the `.ftl` or you get the prefixed-key fallback.
- **Do not bypass `getString` by calling `addon.data.locale.current.formatMessagesSync` directly.** The `_getString` indirection is what applies the `addonRef-` prefix and the fallback policy.

---

## `prefs.ts`

**Path:** `src/utils/prefs.ts:1-36`

Typed, prefix-scoped wrappers around `Zotero.Prefs`. The whole file is three thin functions, but the typing and the prefix handling are the value.

### Imports and prefix

```ts
import { config } from "../../package.json";
type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];
const PREFS_PREFIX = config.prefsPrefix; // prefs.ts:1-5
```

`PluginPrefsMap` is the global type the Zotero type-package generates from the plugin's `prefs.js` — every pref key declared there becomes a property on `PluginPrefsMap`. `PREFS_PREFIX` is `config.prefsPrefix` from `package.json`, the root under which all of this plugin's prefs live (e.g. `extensions.zotero.smart-organizer`). Every call below composes the full pref name as `` `${PREFS_PREFIX}.${key}` ``, so callers use the bare logical key (`getPref("organizer.width")`), never the full dotted branch.

### `getPref`

Reads a plugin preference value from `Zotero.Prefs`, scoped under `PREFS_PREFIX`.

```ts
export function getPref<K extends keyof PluginPrefsMap>(key: K): PluginPrefsMap[K]; // prefs.ts:12-14
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `K extends keyof PluginPrefsMap` | Yes | The bare logical pref key (e.g. `"organizer.width"`). Constrained to known keys so typos surface at compile time. |

**Returns:** `PluginPrefsMap[K]` — the stored pref value, typed to match the key. Internally calls `Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true)` and casts the result.

**Throws:** None directly; may propagate errors from `Zotero.Prefs.get` for malformed pref names.

The generic `K` constrains `key` to a known pref name and lets TypeScript infer the correct value type. The second argument to `Zotero.Prefs.get` is `true`, which requests the *global* pref branch (Zotero's standard behavior for add-on prefs). The `as PluginPrefsMap[K]` cast is required because `Zotero.Prefs.get` is typed to return `any`/`PrefValue` broadly.

### `setPref`

Writes a plugin preference value to `Zotero.Prefs`, scoped under `PREFS_PREFIX`.

```ts
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
): void; // prefs.ts:22-27
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `K extends keyof PluginPrefsMap` | Yes | The bare logical pref key. |
| `value` | `PluginPrefsMap[K]` | Yes | The value to store. Its type is tied to `key`, so `setPref("organizer.width", "not-a-number")` is a compile-time error if `organizer.width` is declared as `number`. |

**Returns:** `void` (the underlying `Zotero.Prefs.set` return value is forwarded but conventionally ignored).

**Throws:** None directly; may propagate errors from `Zotero.Prefs.set`.

The third argument `true` to `Zotero.Prefs.set` again selects the global branch.

### `clearPref`

Clears a plugin preference, restoring it to its default (or removing it if no default is registered).

```ts
export function clearPref(key: string): void; // prefs.ts:34-36
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | Yes | The bare logical pref key to clear. Typed `string` (not `keyof PluginPrefsMap`) intentionally — see prose below. |

**Returns:** `void`.

**Throws:** None directly; may propagate errors from `Zotero.Prefs.clear`.

Notably, `key` is typed `string` rather than `keyof PluginPrefsMap` — this is intentional: `clearPref` is often used in teardown/reset paths where you want to clear a pref that may no longer be in the typed map, or clear an arbitrary pref under the plugin's branch.

> **Note:** The standard for this result asked for `safeGetPref`/`safeSetPref` wrappers. The actual exports are named `getPref`/`setPref`/`clearPref`; there are no `safe*` variants in the source. They are still "safe" in the practical sense — typed keys, typed values, automatic prefix — but the names are as shown here.

### Design decisions

- **Prefix is centralized.** `PREFS_PREFIX` is the single source of truth. Call sites never spell out the `extensions.zotero.smart-organizer.` branch, which is the kind of duplication that produces silent pref-name typos.
- **`true` (global branch) passed explicitly everywhere.** Zotero's `Prefs.get/set/clear` accept a `global` flag; passing `true` is the conventional choice for add-on prefs and matches the `prefs.js` defaults registration. Encoding it in the wrapper means callers can't accidentally pass `false` and read from the wrong branch.
- **Strong typing on `get`/`set`, loose typing on `clear`.** Read/write are constrained to known keys so typos surface at compile time; `clear` is left open because reset paths need to be permissive.

### How to extend

- **Add a new pref:** declare it in `addon/prefs.js` (so Zotero registers a default and `PluginPrefsMap` picks up the key), then use `getPref`/`setPref` with the bare key.
- **Need a pref outside the typed map** (e.g. reading a Zotero-core pref): don't use these wrappers — call `Zotero.Prefs.get(...)` directly with the full pref name. The wrappers exist specifically to keep plugin prefs scoped and typed.

---

## `window.ts`

**Path:** `src/utils/window.ts:1-10`

A single helper that exists because chrome-privileged `Window` objects in Zotero/Firefox have a more nuanced notion of "alive" than web pages do.

### `isWindowAlive`

Returns a truthy value iff `win` is still safe to interact with.

```ts
function isWindowAlive(win?: Window): Window | boolean; // window.ts:8-10
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `win` | `Window` (optional) | No | The window reference to test. May be `undefined`/`null` (no reference held yet) or a chrome `ChromeWindow` (a subtype of `Window`). |

**Returns:** `Window | boolean` — the raw `&&` chain result (either `win` if it is falsy, or a boolean). Truthy iff `win` is present, not a dead wrapper, and not closed. Callers use it in `if` conditions; wrap in `Boolean(...)` for a strict boolean.

**Throws:** None. (`Components.utils.isDeadWrapper` is precisely the check that lets us avoid the throw that would come from touching a dead wrapper's properties.)

Three checks, all required:

1. **`win` itself is truthy.** Handles the `undefined` case (no window reference held yet) and `null`.
2. **`!Components.utils.isDeadWrapper(win)`.** In Firefox's multi-process / compartment model, a chrome object can become a *dead wrapper* — the underlying compartment has been torn down but the JS reference still exists. Touching any property of a dead wrapper throws. `Components.utils.isDeadWrapper` is the official way to detect this; you cannot just `try { win.closed } catch` because the property access itself is what throws.
3. **`!win.closed`.** The window object can outlive the user closing the window. `win.closed` becomes `true` once the close has happened, even though the JS reference is still live.

The function is used to prevent opening duplicate organizer windows: before creating a new window, the bootstrap checks `isWindowAlive(existingWin)` and focuses the existing one if so.

### Design decisions

- **`Components` is used unqualified.** It is a chrome-privileged global available in the add-on sandbox; using it directly is the conventional pattern. There is no fallback because `Components.utils.isDeadWrapper` is the only reliable signal — `try/catch` around property access is the alternative but it conflates "dead wrapper" with "the property access itself threw for unrelated reasons".
- **Returns the result of `&&`, not a boolean.** The expression `win && !a && !b` evaluates to either `win` (if `win` is falsy) or a boolean. Callers use it in `if` conditions, where the distinction is irrelevant; keeping it as the raw `&&` chain avoids an unnecessary `!!` coercion. If you want a strict boolean, wrap the call in `Boolean(...)` at the call site.
- **No `Window`-vs-`ChromeWindow` distinction.** The parameter is typed `Window`. Zotero's chrome windows are `ChromeWindow` (a subtype), so the helper accepts both.

### How to extend

Don't add helpers here unless they relate to window liveness. If you need to focus or close a window, do it at the call site using the standard `win.focus()` / `win.close()` after checking `isWindowAlive`.

---

## `ztoolkit.ts`

**Path:** `src/utils/ztoolkit.ts:1-49`

Constructs and configures the singleton `ZoteroToolkit` instance the rest of the plugin uses as `ztoolkit`. This is the entry point for everything the `zotero-plugin-toolkit` library provides: logging, UI helpers, ProgressWindow, virtual tables, etc.

### `createZToolkit`

Allocates a full `ZoteroToolkit`, runs it through `initZToolkit`, and returns the configured instance.

```ts
function createZToolkit(): ZoteroToolkit; // ztoolkit.ts:6-15
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| *(none)* | — | — | — |

**Returns:** `ZoteroToolkit` — a fully-configured toolkit instance. The bootstrap typically assigns this to the global `ztoolkit` once, at startup.

**Throws:** None directly; may propagate from the `ZoteroToolkit` constructor or `initZToolkit`.

A commented-out alternative (`ztoolkit.ts:11-12`) shows that you can instead instantiate a `MyToolkit` — a slimmed-down subclass that imports only the modules you use, to minify bundle size. The default is the full `ZoteroToolkit` because the plugin uses UI helpers, ProgressWindow, and logging; switch to `MyToolkit` only if you want to actively trim the bundle.

### `initZToolkit`

Configures logging, UI element-logging, plugin ID, and the default ProgressWindow icon on a freshly-constructed toolkit instance.

```ts
function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>): void; // ztoolkit.ts:17-32
```

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `_ztoolkit` | `ReturnType<typeof createZToolkit>` | Yes | The toolkit instance to configure (in practice, a `ZoteroToolkit` or `MyToolkit`). |

**Returns:** `void` — mutates `_ztoolkit` in place.

**Throws:** None.

Configuration performed:

| Line | Setting | Effect |
| --- | --- | --- |
| `ztoolkit.ts:18` | `env = __env__` | Captures the build-time environment global (`"development"` or `"production"`) injected by the bundler. |
| `ztoolkit.ts:19` | `basicOptions.log.prefix = `[${config.addonName}]`` | Every log line from the toolkit is prefixed with `[Smart Organizer]` (or whatever `addonName` is in `package.json`). |
| `ztoolkit.ts:20` | `basicOptions.log.disableConsole = env === "production"` | Console logging is silenced in production builds to avoid noise in the Zotero console. Development builds keep it on. |
| `ztoolkit.ts:21-22` | `UI.basicOptions.ui.enableElementJSONLog / enableElementDOMLog = __env__ === "development"` | The toolkit's UI tool, in dev builds, logs every element it manages in both JSON and DOM form. Disabled in production. |
| `ztoolkit.ts:25-26` (commented) | `basicOptions.debug.disableDebugBridgePassword` | Intentionally disabled — see comment. Loading `basicOptions.debug` pulls in global modules like the debug bridge, which the plugin is intentionally avoiding because that API is being deprecated. |
| `ztoolkit.ts:27` | `basicOptions.api.pluginID = config.addonID` | The toolkit's API surface knows the plugin's ID (used for some Zotero API calls and for telemetry). |
| `ztoolkit.ts:28-31` | `ProgressWindow.setIconURI("default", chrome://...favicon.png)` | Sets the default icon for the toolkit's `ProgressWindow` to the plugin's favicon, served from the plugin's chrome URL. |

### `MyToolkit` (alternative slim toolkit)

```ts
import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { UITool } from "zotero-plugin-toolkit";

class MyToolkit extends BasicTool {
  UI: UITool;
  constructor() {
    super();
    this.UI = new UITool(this);
  }
  unregisterAll() {
    unregister(this);
  }
} // ztoolkit.ts:34-48
```

**Fields**

| Name | Type | Description |
| --- | --- | --- |
| `UI` | `UITool` | The UI tool instance bound to this toolkit; provides element-management helpers. |

**Methods**

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `new MyToolkit()` | Allocates the `BasicTool` base and attaches a fresh `UITool`. |
| `unregisterAll` | `unregisterAll(): void` | Calls `unregister(this)` from the toolkit library — explicit teardown for hot-reload during development and clean shutdown. |

A minimal toolkit that pulls in only `BasicTool` + `UITool`. Use it (by switching the `new ZoteroToolkit()` line in `createZToolkit` to `new MyToolkit()`) when you want to tree-shake unused toolkit modules out of the bundle. `unregisterAll` provides an explicit teardown path that calls `unregister(this)` from the toolkit library — important for hot-reload during development and for clean shutdown.

Note the import placement: `MyToolkit` and its imports sit *after* `createZToolkit`/`initZToolkit`. That is intentional — it keeps the default path (full `ZoteroToolkit`) visually first and the opt-in slim path second. The imports are hoisted by the bundler so the order is not a runtime concern.

### Design decisions

- **Build-time `__env__` global.** The dev/prod branching is done at *build* time, not runtime, so production builds ship with the verbose logging paths stripped. `__env__` is a global the bundler replaces (the same pattern Vite/Webpack use for `process.env.NODE_ENV`).
- **Debug bridge deliberately left disabled.** The commented-out `disableDebugBridgePassword` line (`ztoolkit.ts:25-26`) is left in the source as a signpost: the debug bridge pulls in heavyweight global modules and is slated for deprecation in the toolkit, so this plugin avoids even touching `basicOptions.debug`. Do not uncomment it without understanding the consequences.
- **`setIconURI` uses a `chrome://` URL.** The favicon is served from the plugin's chrome registration (`chrome://${addonRef}/content/...`), which is set up by the bootstrap's chrome manifest. This is the conventional way to ship static assets with a Zotero plugin.
- **`createZToolkit` is the only export.** `initZToolkit` and `MyToolkit` are module-private. Callers get a fully-configured toolkit instance and never see the configuration step.

### How to extend

- **Adding a new toolkit-driven feature:** you usually don't need to touch this file — `ztoolkit` is already configured and exposed globally by the bootstrap. Use `ztoolkit.UI.xxx`, `ztoolkit.ProgressWindow`, `ztoolkit.getGlobal(...)`, etc. directly.
- **Switching to the slim toolkit:** uncomment `const _ztoolkit = new MyToolkit();` in `createZToolkit` and ensure every toolkit API you actually use is imported in `MyToolkit`. The `MyToolkit` class as written only provides `BasicTool` + `UI`; add other tools (e.g. `VirtualizedTable`, `FieldHook`) the same way `UI` is added.
- **Changing log verbosity at runtime:** set `ztoolkit.basicOptions.log.disableConsole` from elsewhere in the plugin (e.g. a debug toggle in the prefs UI). The `initZToolkit` value is just the build-time default.

---

## Cross-cutting notes

### Globals these modules rely on

Every utility assumes the add-on bootstrap has populated the standard set of Zotero-plugin globals:

- `addon` — the add-on singleton (state lives on `addon.data.*`).
- `ztoolkit` — the `ZoteroToolkit` instance produced by `createZToolkit` in `ztoolkit.ts`.
- `__env__` — build-time environment string.
- `Zotero` — the host application object (used for `Zotero.Prefs`).
- `Components` — chrome-privileged Firefox global (used by `window.ts` for `Components.utils.isDeadWrapper`).
- `Localization` — Mozilla Fluent constructor (may be undefined; `locale.ts` falls back to `ztoolkit.getGlobal`).
- `_ZoteroTypes.Prefs.PluginPrefsMap` — the global pref-key→value type map generated from `prefs.js`.

If any of these is missing, the corresponding utility will fail at call time, not at import time — these modules do not guard against a misconfigured bootstrap.

### Where to add new utilities

Keep `src/utils/` for *leaf* helpers with no dependencies on the rest of the plugin's source. A new helper that imports from `src/modules/` or `src/dialogs/` does not belong here — put it next to its consumer. The convention across these five files is: one responsibility per file, no cross-imports between utils, typed public surfaces, and a comment block at the top of each file explaining *why* the helper exists (the XUL-namespace comment in `domHelpers.ts` is the model).

### Versioning & migration context

`domHelpers.ts` and `locale.ts` both encode post-Zotero-7 migration patterns: HTML-namespace element creation (replacing `createElement` for XUL) and the `Localization`/Fluent system (replacing the old DTD/properties string bundles). When upgrading the plugin to a new Zotero major version, these are the files most likely to need adjustment, because both Firefox and Zotero periodically change sandbox globals and DOM-namespace rules. `prefs.ts`, `window.ts`, and `ztoolkit.ts` are comparatively stable — they wrap APIs (`Zotero.Prefs`, `Components.utils`, `zotero-plugin-toolkit`) that the toolkit maintainers keep version-aligned.
