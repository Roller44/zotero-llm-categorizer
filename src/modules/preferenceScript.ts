import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { testConnection } from "./llmClient";
import {
  DEFAULT_CLASSIFICATION_SYSTEM_PROMPT,
  DEFAULT_TAXONOMY_SYSTEM_PROMPT,
} from "./promptBuilder";

const PREFS_PREFIX = config.prefsPrefix;
const REF = config.addonRef;

/**
 * Register the preference pane with Zotero. Called once at startup.
 *
 * `Zotero.PreferencePanes.register` is async (preferencePanes.js:134); awaiting
 * it ensures any rejection (duplicate pane ID, resolveURI failure, etc.) is
 * surfaced to the caller's try/catch instead of becoming an unhandled
 * rejection.
 */
export async function registerPrefs(): Promise<void> {
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${REF}/content/icons/favicon.png`,
  });
}

/**
 * Wire up the preference pane controls when it loads.
 * Called from preferences.xhtml onload -> hooks.onPrefsEvent("load").
 */
export async function registerPrefsScripts(win: Window): Promise<void> {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: win,
    } as any;
  } else {
    addon.data.prefs.window = win;
  }

  const doc = win.document;

  const fields: Array<{ id: string; pref: string }> = [
    { id: `${REF}-endpoint`, pref: "endpoint" },
    { id: `${REF}-apiKey`, pref: "apiKey" },
    { id: `${REF}-model`, pref: "model" },
    { id: `${REF}-provider`, pref: "provider" },
    { id: `${REF}-maxTokens`, pref: "maxTokens" },
    { id: `${REF}-timeoutSeconds`, pref: "timeoutSeconds" },
    { id: `${REF}-reasoningEffort`, pref: "reasoningEffort" },
    { id: `${REF}-taxonomySystemPrompt`, pref: "taxonomySystemPrompt" },
    { id: `${REF}-classificationSystemPrompt`, pref: "classificationSystemPrompt" },
  ];

  // Initialize each control from the stored pref and persist on change.
  for (const { id, pref } of fields) {
    const el = doc.getElementById(`zotero-prefpane-${id}`) as any;
    if (!el) continue;

    // Read current value, defaulting to "" if the pref doesn't exist yet.
    let current = "";
    try {
      current = (Zotero.Prefs.get(`${PREFS_PREFIX}.${pref}`, true) as
        | string
        | undefined) || "";
    } catch {
      current = "";
    }
    setControlValue(el, current);

    const persist = () => {
      try {
        Zotero.Prefs.set(`${PREFS_PREFIX}.${pref}`, getControlValue(el), true);
      } catch (e) {
        Zotero.debug(`[SmartOrganizer] Failed to persist pref ${pref}: ${e}`);
      }
    };
    // Listen to multiple event types for cross-platform robustness.
    el.addEventListener("command", persist);
    el.addEventListener("change", persist);
    el.addEventListener("input", persist);
    el.addEventListener("blur", persist);
  }

  // For the two custom-prompt textareas, if the stored pref is empty, show the
  // default prompt as a placeholder value in the textarea (without persisting
  // it, so the user can edit and save, or leave it as-is to use the default).
  const defaults: Array<{ id: string; text: string }> = [
    {
      id: `${REF}-taxonomySystemPrompt`,
      text: DEFAULT_TAXONOMY_SYSTEM_PROMPT,
    },
    {
      id: `${REF}-classificationSystemPrompt`,
      text: DEFAULT_CLASSIFICATION_SYSTEM_PROMPT,
    },
  ];
  for (const { id, text } of defaults) {
    const el = doc.getElementById(`zotero-prefpane-${id}`) as any;
    if (!el) continue;
    if (!el.value || String(el.value).trim().length === 0) {
      // The control is an <html:textarea> (a real editable HTML element in
      // Zotero 7). Setting .value displays the default prompt and keeps the
      // field editable. No "value" attribute is needed on an HTML textarea.
      el.value = text;
    }
  }

  // Test connection button.
  const testBtn = doc.getElementById(`zotero-prefpane-${REF}-test-btn`);
  const testResult = doc.getElementById(
    `zotero-prefpane-${REF}-test-result`,
  ) as HTMLElement | null;

  const runTest = async () => {
    // Force-persist all field values before testing, in case event
    // listeners didn't fire (e.g. user typed but didn't blur the field).
    for (const { id, pref } of fields) {
      const el = doc.getElementById(`zotero-prefpane-${id}`) as any;
      if (el) {
        try {
          Zotero.Prefs.set(`${PREFS_PREFIX}.${pref}`, getControlValue(el), true);
        } catch (e) {
          Zotero.debug(`[SmartOrganizer] Failed to persist pref ${pref} before test: ${e}`);
        }
      }
    }

    if (testResult) {
      testResult.textContent = getString("pref-testing");
      testResult.style.color = "var(--fill-secondary)";
    }
    const result = await testConnection();
    if (testResult) {
      testResult.textContent = result.message;
      testResult.style.color = result.ok
        ? "var(--accent-green)"
        : "var(--accent-red)";
    }
  };

  testBtn?.addEventListener("command", runTest);
  testBtn?.addEventListener("click", runTest);
}

function getControlValue(el: any): string {
  // Use localName (always lowercase, namespace-agnostic) rather than tagName,
  // which avoids casing/prefix pitfalls across Zotero versions and makes the
  // html:textarea migration work regardless of namespace prefix.
  if (el.localName === "menulist" || el.localName === "menu") {
    return String(el.value ?? "");
  }
  return String(el.value ?? "");
}

function setControlValue(el: any, value: string): void {
  if (el.localName === "menulist" || el.localName === "menu") {
    el.value = value;
  } else {
    el.value = value;
  }
}
