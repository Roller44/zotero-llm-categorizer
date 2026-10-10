# Preferences Pane

The Smart Organizer exposes a Zotero-native preference pane that lets the user configure the LLM backend used for classification: the API endpoint, credentials, model, provider, request budgets, reasoning effort, and two user-overridable system prompts. This document covers the three files that together implement the pane:

- `addon/prefs.js` — declares the default values Zotero writes into its prefs DB on install.
- `addon/content/preferences.xhtml` — the XUL/HTML markup for the pane.
- `src/modules/preferenceScript.ts` — the TypeScript that wires the markup to `Zotero.Prefs` at runtime and hosts the "Test connection" button.

The pane is registered at startup and bound to the DOM when the user opens it. All values live under the `extensions.zotero-smart-organizer.*` pref branch.

---

## 1. Default values — `addon/prefs.js`

`prefs.js` is a standard Zotero scaffold file. Each `pref(key, value)` line declares a default that Zotero persists on first install (and re-applies if the user resets the pane). The scaffold prepends `extensions.zotero-smart-organizer.` to each key (`prefs.js:2-3`), so the on-disk pref keys are fully-qualified.

| Pref key | Default | Type as written | Consumed as |
|---|---|---|---|
| `endpoint` | `https://api.openai.com/v1` | string | URL string |
| `apiKey` | `""` | string | secret string |
| `model` | `gpt-4o-mini` | string | model id |
| `provider` | `openai` | string | `"openai" \| "anthropic"` |
| `maxTokens` | `"16384"` | **string** | parsed to int at read time |
| `timeoutSeconds` | `"300"` | **string** | parsed to int at read time |
| `reasoningEffort` | `none` | string | `"none" \| "low" \| "medium" \| "high"` |
| `taxonomySystemPrompt` | `""` | string | falls back to `DEFAULT_TAXONOMY_SYSTEM_PROMPT` |
| `classificationSystemPrompt` | `""` | string | falls back to `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` |

`prefs.js:1-12` — full file.

### Design notes

- **Numeric fields are stored as strings.** `maxTokens` and `timeoutSeconds` are declared as string literals (`"16384"`, `"300"`) even though they are semantically integers. This is deliberate: Zotero's pref system has no dedicated integer branch that round-trips reliably through the XUL `<html:input type="text">` controls used in `preferences.xhtml`, so the value is stored as a string and parsed with `parseInt` at read time in `llmClient.ts` (`safeGetInt`, `llmClient.ts:77-81`). `safeGetInt` returns the default if the parse fails or the value is `<= 0`, which is the only place an invalid user entry is sanitized.
- **The two prompt prefs default to empty, not to the default prompt text.** This is what allows the "leave empty for default" semantics advertised in the pane labels (`preferences.xhtml:127, 138`). The default prompt text lives in code (`promptBuilder.ts:77, 106`) and is substituted at runtime by `buildTaxonomyMessages` / `buildClassificationMessages` when the pref is blank. The pane does *preload* the default text into the textarea (see §4), but it does not persist that preload — saving only happens on user edit.
- **`provider` defaults to `openai`, never `auto`.** The dropdown in the pane (`preferences.xhtml:53-67`) only offers `openai` and `anthropic`. There is no `auto` option in the UI. However, `getSettings()` in `llmClient.ts:87` falls back to `"auto"` if the pref is somehow blank, and `normalizeProvider` then resolves `auto` from the endpoint hostname. That fallback is a safety net for corrupt/missing prefs, not a user-facing choice — the pane cannot produce it.

---

## 2. Markup — `addon/content/preferences.xhtml`

The pane is a single `<groupbox>` whose `onload` calls `Zotero.__addonInstance__.hooks.onPrefsEvent('load', { window })` (`preferences.xhtml:5`). That hook routes into `registerPrefsScripts` (§3). The `__addonRef__` placeholder is rewritten by the build scaffold to the addon's ref string, so element ids like `zotero-prefpane-__addonRef__-endpoint` become e.g. `zotero-prefpane-zotero-smart-organizer-endpoint` at runtime.

### Controls

Each setting is an `<hbox>` pairing a `<html:label>` (localized via `data-l10n-id`) with an input control. The `preference="..."` attribute is a Zotero convention that *names* the pref the control binds to, but binding is not automatic — `preferenceScript.ts` does the actual read/write.

| Field | Control | `id` suffix | Localized label |
|---|---|---|---|
| Endpoint | `<html:input type="text">` | `-endpoint` | `pref-endpoint` |
| API key | `<html:input type="password">` | `-apiKey` | `pref-apikey` |
| Model | `<html:input type="text">` | `-model` | `pref-model` |
| Provider | `<menulist>` | `-provider` | `pref-provider` |
| Max tokens | `<html:input type="text">` | `-maxTokens` | `pref-max-tokens` |
| Timeout (s) | `<html:input type="text">` | `-timeoutSeconds` | `pref-timeout` |
| Reasoning effort | `<menulist>` | `-reasoningEffort` | `pref-reasoning-effort` |
| Taxonomy system prompt | `<html:textarea>` | `-taxonomySystemPrompt` | hard-coded label |
| Classification system prompt | `<html:textarea>` | `-classificationSystemPrompt` | hard-coded label |
| Test button | `<html:button type="button">` | `-test-btn` | `pref-test-button` |
| Test result | `<html:span>` | `-test-result` | — |

`preferences.xhtml:1-166` — full file.

### Provider dropdown

`preferences.xhtml:53-67` — the provider `<menulist>` exposes exactly two `<menuitem>`s: `openai` and `anthropic`. There is **no `auto` item**. This is a deliberate narrowing: the pane forces an explicit provider choice so the request builder (`buildRequestPure` in `llmClient`) receives an unambiguous value, and the `auto` resolution path in `normalizeProvider` only triggers when the pref is missing entirely.

### Reasoning effort dropdown

`preferences.xhtml:101-123` — four values: `none`, `low`, `medium`, `high`. `none` is the default (`prefs.js:10`) and means "do not send a reasoning parameter" — the request builder omits the reasoning field entirely when effort is `none`. This dropdown is provider-aware in the request builder (Anthropic uses `thinking.budget_tokens`, OpenAI uses `reasoning_effort`), but the pane itself is provider-agnostic: all four options are always selectable.

### Custom prompt textareas

`preferences.xhtml:126-146` — two `<html:textarea>` elements, each 140px tall, monospace, non-resizable, with a hard-coded English label `"(leave empty for default)"`. They are real HTML elements (not XUL `<textbox multiline="true">`), which matters for the value-setting logic in §3: HTML textareas expose `.value` as a property and do not need a `value` attribute on the element.

### Test connection row

`preferences.xhtml:148-158` — a `<html:button>` and a `<html:span>` for the result. The span has no initial content; `preferenceScript.ts` writes the status text into it.

### Footer

`preferences.xhtml:160-165` — a `<vbox>` with a single localized label (`pref-help`) whose `data-l10n-args` carries the build time, addon name, and version. These are rewritten by the scaffold at packaging time.

---

## 3. Wiring — `src/modules/preferenceScript.ts`

This module is the runtime brain of the pane. It exports two functions: `registerPrefs` (called once at startup) and `registerPrefsScripts` (called every time the pane is opened). It also has two private helpers, `getControlValue` and `setControlValue`.

### registerPrefs

Registers the Smart Organizer preference pane with Zotero's preference-pane registry at startup.

```ts
export async function registerPrefs(): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| — | — | — | No parameters. |

**Returns:** `Promise<void>` — resolves when `Zotero.PreferencePanes.register` has completed.

**Throws:** Rejects (propagates the rejection from `Zotero.PreferencePanes.register`) on a duplicate pane ID, a `resolveURI` failure, or a missing `src` file.

`preferenceScript.ts:20-27`. Calls `Zotero.PreferencePanes.register` with the addon ID, the `content/preferences.xhtml` source URI (resolved via `rootURI`), a localized label, and the favicon as the pane icon.

**Why `async`/`await` rather than fire-and-forget:** the comment at `preferenceScript.ts:14-19` spells this out — `Zotero.PreferencePanes.register` is async (per `preferencePanes.js:134` in Zotero's source) and awaiting it ensures any rejection (duplicate pane ID, `resolveURI` failure, missing src file) is surfaced to the caller's `try/catch` instead of becoming an unhandled rejection that silently leaves the pane unregistered. The caller (the addon bootstrap) awaits this in its startup hook.

### registerPrefsScripts

Wires the pane's controls to the persisted prefs every time the user opens the pane: reads each pref into its control, attaches persist-on-change listeners, pre-fills the default prompt text into empty textareas, and wires the Test Connection button.

```ts
export async function registerPrefsScripts(win: Window): Promise<void>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `win` | `Window` | Yes | The pane window whose `document` holds the controls to wire. |

**Returns:** `Promise<void>` — resolves once all controls have been initialized and listeners attached.

**Throws:** None. Individual field read/persist failures are caught and logged via `Zotero.debug`; missing controls are skipped silently.

`preferenceScript.ts:33-145`. Invoked from `preferences.xhtml`'s `onload` via `hooks.onPrefsEvent("load", { window })`. It:

1. **Stores the pane window** on `addon.data.prefs` (`preferenceScript.ts:34-40`) so other modules can reach the live DOM if needed. It initializes the object if absent, and overwrites only the `window` field otherwise.
2. **Defines the field table** (`preferenceScript.ts:44-54`) — an array of `{ id, pref }` pairs mapping each control's id-suffix to its pref key. This is the single source of truth for which controls get wired; adding a new setting means adding a row here and a control in the XHTML.
3. **Reads + persists each field** (`preferenceScript.ts:57-84`).
4. **Pre-fills the two prompt textareas** with default text if empty (`preferenceScript.ts:89-108`).
5. **Wires the Test Connection button** (`preferenceScript.ts:111-144`).

#### The field table

```ts
const fields: Array<{ id: string; pref: string }> = [
  { id: `${REF}-endpoint`,                   pref: "endpoint" },
  { id: `${REF}-apiKey`,                     pref: "apiKey" },
  { id: `${REF}-model`,                      pref: "model" },
  { id: `${REF}-provider`,                   pref: "provider" },
  { id: `${REF}-maxTokens`,                  pref: "maxTokens" },
  { id: `${REF}-timeoutSeconds`,             pref: "timeoutSeconds" },
  { id: `${REF}-reasoningEffort`,            pref: "reasoningEffort" },
  { id: `${REF}-taxonomySystemPrompt`,       pref: "taxonomySystemPrompt" },
  { id: `${REF}-classificationSystemPrompt`, pref: "classificationSystemPrompt" },
];
```

`preferenceScript.ts:44-54`. The id is the suffix appended after `zotero-prefpane-`; the pref is the bare key under `extensions.zotero-smart-organizer.`. The Test button and result span are intentionally **not** in this table — they are not prefs.

#### Read + persist loop

For each field (`preferenceScript.ts:57-84`):

1. Look up the element by `zotero-prefpane-${id}`. Skip silently if missing (`if (!el) continue`) — this makes a missing control non-fatal, which is useful during incremental development.
2. Read the current pref via the **`Zotero.Prefs.get` throws-not-returns-undefined** pattern (see §3.4) wrapped in a try/catch, defaulting to `""`.
3. Call `setControlValue(el, current)` to populate the control.
4. Define a `persist` closure that writes the control's value back via `Zotero.Prefs.set(`${PREFS_PREFIX}.${pref}`, getControlValue(el), true)`. The third arg `true` means "global" (not user-scoped). Failures are logged via `Zotero.debug` rather than thrown, so a single bad field can't break the rest of the pane.
5. Attach `persist` to **four** events: `command`, `change`, `input`, `blur` (`preferenceScript.ts:80-83`). The multi-event subscription is a cross-platform robustness measure: `<menulist>` fires `command`, `<html:input>` fires `change`/`input`, and `blur` is a catch-all for textareas where `input` can be unreliable on some builds. Subscribing to all four is intentionally redundant — `Zotero.Prefs.set` is idempotent and cheap.

#### Default-prompt pre-fill

`preferenceScript.ts:89-108`. After the read/persist loop runs, the two prompt textareas are checked again: if their value is empty (`!el.value || String(el.value).trim().length === 0`), the corresponding `DEFAULT_*_SYSTEM_PROMPT` constant is written into `el.value`. The comment at `preferenceScript.ts:103-105` explains the mechanism: in Zotero 7 the control is a real `<html:textarea>`, so setting `.value` displays the default text and keeps the field editable — no `value` attribute is needed.

This pre-fill is **display-only**. Because the user has not fired an `input`/`change`/`blur` event, `persist` is never called, and the pref stays `""`. The semantics are:

- If the user touches the textarea at all, the (possibly edited) default text gets persisted on the next event.
- If the user leaves it alone, the pref remains empty and the request builder substitutes `DEFAULT_TAXONOMY_SYSTEM_PROMPT` / `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT` at call time (`promptBuilder.ts:181, 214`).

This is the mechanism that backs the "(leave empty for default)" labels in the XHTML. The defaults are imported from `promptBuilder.ts` at `preferenceScript.ts:4-7`.

#### Test Connection button

`preferenceScript.ts:111-144`. The `runTest` closure:

1. **Force-persists every field** before testing (`preferenceScript.ts:119-128`). This defends against the case where the user typed a value but never blurred the field — without this, `testConnection()` would read the stale pref and the test would use the wrong endpoint/key/model. Each persist is individually try/caught and logged, so one bad field doesn't abort the test.
2. Sets the result span to the localized "testing…" message (`pref-testing`) with a neutral color (`--fill-secondary`).
3. Calls `testConnection()` from `./llmClient`.
4. Writes `result.message` into the span, colored `--accent-green` on success or `--accent-red` on failure.

The button is wired to both `command` and `click` (`preferenceScript.ts:143-144`) for the same cross-platform reason as the field listeners — `<html:button>` fires `click`, while XUL buttons fire `command`.

##### What `testConnection()` does

`llmClient.ts:359-386`. It reads settings via `getSettings()`, validates that `endpoint`, `apiKey`, and `model` are non-empty (returning a localized-ish error string for each missing field), then sends a one-message chat (`role: "user", content: "ping"`) with `max_tokens: 16`. On success it returns `{ ok: true, message: "Connection successful. Reply: <preview>" }` where `<preview>` is the first 120 chars of the reply, whitespace-collapsed. On throw it returns `{ ok: false, message: (e as Error).message }`. It never throws — failures become `ok: false` — which is why the pane's `runTest` can `await` it without a try/catch.

### getControlValue

Reads the current value of a pane control as a string, normalizing `null`/`undefined` to `""`.

```ts
function getControlValue(el: any): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `el` | `any` | Yes | The DOM control to read from. May be an `<html:input>`, `<html:textarea>`, `<menulist>`, or `<menu>`. |

**Returns:** `string` — the control's `.value`, coerced to string; `""` if the value is null/undefined.

**Throws:** None.

`preferenceScript.ts:147-155`. Branches on `el.localName === "menulist" || el.localName === "menu"`, but both branches return the same `String(el.value ?? "")`. The branching is currently a no-op seam — it exists so that future control types (e.g. a `<checkbox>` whose value is `el.checked`) can be added without restructuring the call sites.

### setControlValue

Writes a string value into a pane control.

```ts
function setControlValue(el: any, value: string): void
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `el` | `any` | Yes | The DOM control to write to. May be an `<html:input>`, `<html:textarea>`, `<menulist>`, or `<menu>`. |
| `value` | `string` | Yes | The string to assign to the control's `.value`. |

**Returns:** `void`.

**Throws:** None.

`preferenceScript.ts:157-163`. Branches on `el.localName === "menulist" || el.localName === "menu"`, but in both branches the body is identical (`el.value = value`). The branching is currently a no-op seam — it exists so that future control types (e.g. a `<checkbox>` whose value is `el.checked`) can be added without restructuring the call sites.

**Why `localName` and not `tagName`:** the comment at `preferenceScript.ts:149-150` explains. `localName` is always lowercase and namespace-agnostic, whereas `tagName` preserves casing and any XML namespace prefix (e.g. `html:textarea` vs `HTML:TEXTAREA` vs `textarea`). The pane mixes XUL elements (`<menulist>`, `<menu>`) with HTML elements (`<html:textarea>`, `<html:input>`, `<html:button>`) in the same document, so a namespace-agnostic check is the only reliable discriminator. This was a bug-motivated choice: an earlier version that used `tagName` comparisons broke when the textareas were migrated from XUL `<textbox>` to `<html:textarea>` and the prefix casing differed across Zotero builds.

### 3.4 The `Zotero.Prefs.get` "throws, doesn't return undefined" pattern

This is the single most important quirk the pane works around. `Zotero.Prefs.get(key, true)` does **not** return `undefined` for a missing pref — it **throws**. The `|| ""` fallback in `current = (Zotero.Prefs.get(...) as string | undefined) || ""` (`preferenceScript.ts:64-66`) only catches the `undefined`/empty-string case, not the thrown case, so the entire read is wrapped in `try { ... } catch { current = ""; }`.

The same pattern appears in `llmClient.ts:67-73` as `safeGetPref`:

```ts
function safeGetPref(key: string): string {
  try {
    return (Zotero.Prefs.get(key, true) as string | undefined) || "";
  } catch {
    return "";
  }
}
```

`preferenceScript.ts` does **not** import `safeGetPref` — it inlines the same try/catch at `preferenceScript.ts:62-69` and again inside the `runTest` persist loop (`preferenceScript.ts:122-127`). The duplication is intentional: the pane module has a different error-handling policy (it logs on write failure but not on read failure, while `safeGetPref` is silent on both). If you add a new pref read in this module, follow the same try/catch-or-`safeGetPref` discipline — a bare `Zotero.Prefs.get(key, true) || ""` will throw for a fresh install where the pref has never been written.

The second argument `true` to `Zotero.Prefs.get` / `Zotero.Prefs.set` is the `global` flag — it tells Zotero to use the `extensions.*` branch rooted at the prefs prefix rather than the user-scoped branch. It must match between read and write, and it must be `true` for the `extensions.zotero-smart-organizer.*` keys that `prefs.js` declares.

---

## 4. Module exports

| Symbol | Kind | Source | Purpose |
|---|---|---|---|
| `registerPrefs` | `async function` | `preferenceScript.ts:20` | Register the pane with Zotero at startup |
| `registerPrefsScripts` | `async function` | `preferenceScript.ts:33` | Wire controls when the pane loads |
| `getControlValue` | function (private) | `preferenceScript.ts:147` | Read a control's value as a string |
| `setControlValue` | function (private) | `preferenceScript.ts:157` | Write a string into a control |

Imports:

- `config` from `../../package.json` — provides `prefsPrefix` (the full `extensions.zotero-smart-organizer` branch) and `addonRef` (the id-suffix string).
- `getString` from `../utils/locale` — localized strings for the pane title and the "testing…" message.
- `testConnection` from `./llmClient` — the network ping used by the Test button.
- `DEFAULT_CLASSIFICATION_SYSTEM_PROMPT`, `DEFAULT_TAXONOMY_SYSTEM_PROMPT` from `./promptBuilder` — the default prompt text pre-filled into the textareas.

---

## 5. Lifecycle and interaction with other modules

```
addon bootstrap (startup)
  └─ await registerPrefs()                      # registers pane URI with Zotero

user opens pane
  └─ preferences.xhtml onload
      └─ hooks.onPrefsEvent("load", { window })
          └─ registerPrefsScripts(win)          # reads prefs, wires events
                ├─ read loop  -> Zotero.Prefs.get  (per field)
                ├─ persist cb -> Zotero.Prefs.set  (on command/change/input/blur)
                ├─ prompt pre-fill (display-only)
                └─ Test button -> runTest()
                      ├─ force-persist all fields
                      └─ testConnection() (llmClient.ts)
                            └─ getSettings() -> safeGetPref -> Zotero.Prefs.get
                            └─ chatComplete(...) -> fetch
```

The pane is the **only** writer to these prefs in normal operation. Other modules (`llmClient.getSettings`, `promptBuilder`) are read-only consumers via `safeGetPref`. The pane is therefore the gatekeeper for shape and types: if a field is added here, `getSettings()` in `llmClient.ts:83-100` must be updated to read it, and `prefs.js` must declare a default.

---

## 6. Extending the pane

To add a new setting:

1. **Declare a default** in `addon/prefs.js` (e.g. `pref("myNewField", "");`). Without this, the pref does not exist on a fresh install and the `Zotero.Prefs.get` throw path is exercised on every read.
2. **Add a control** in `addon/content/preferences.xhtml` with id `zotero-prefpane-${REF}-myNewField` and a `preference="myNewField"` attribute. Add a localized `<html:label>` with a `data-l10n-id`, and add that id to `addon/locale/*/preferences.ftl`.
3. **Add a row** to the `fields` array in `preferenceScript.ts:44-54`. The read/persist loop will pick it up automatically — no other change to the wiring is needed.
4. **Consume it** in `llmClient.getSettings()` (`llmClient.ts:83-100`) via `safeGetPref`. If it is numeric, use `safeGetInt` (`llmClient.ts:77-81`) instead and pass a sensible default.
5. **Add to the force-persist loop** in `runTest` — this is automatic because `runTest` iterates the same `fields` array (`preferenceScript.ts:119-128`), so step 3 covers it.

To add a new provider:

1. Add a `<menuitem value="newprovider">` to the provider `<menulist>` in `preferences.xhtml:57-66`.
2. Teach `normalizeProvider` in `llmClient.ts` to accept the new value (otherwise it falls back to `openai`).
3. Teach `buildRequestPure` to format the new provider's request body and headers.

Note that adding a provider is **not** as simple as adding a menu item — the request builder is provider-specific (OpenAI vs Anthropic use different JSON shapes, different auth headers, and different reasoning-effort field names). There is deliberately no `auto` menu item; if you want `auto`, you'd add it as an explicit menu choice, but the design intent is that the pane forces an explicit selection.

---

## 7. Known gotchas

- **Never read a pref with a bare `Zotero.Prefs.get(key, true) || ""`.** Wrap in try/catch or use `safeGetPref`. The throw-on-missing behavior is documented at `preferenceScript.ts:62-69` and `llmClient.ts:62-66`.
- **The prompt textareas are display-prefilled, not value-prefilled.** If you write a test that opens the pane and reads `el.value`, you'll see the default prompt text even though the pref is `""`. The pref only becomes non-empty after a user edit.
- **`maxTokens` and `timeoutSeconds` are strings in the pref DB.** Comparisons or arithmetic must go through `parseInt`. `safeGetInt` is the sanctioned reader.
- **The `getControlValue`/`setControlValue` branch on `localName` is currently a no-op seam.** Don't assume it discriminates behavior today — both branches do the same thing. The seam exists for future control types.
- **The pane must be re-registered on every startup.** `registerPrefs` is idempotent in practice (Zotero dedupes by `pluginID`), but a changed `src` URI requires a restart — Zotero caches the pane URI.
