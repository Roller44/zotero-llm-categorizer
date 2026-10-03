import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefs,
  registerPrefsScripts,
} from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import {
  readLibrary,
  summarizeLibrary,
  type LibrarySummary,
} from "./modules/libraryReader";
import { openReviewWindow } from "./modules/organizerUI";
// The review window is initialized directly from openReviewWindow()
// (organizerUI.ts), which awaits the chrome:// window's load event and then
// calls initOrganizerUI in the plugin context. There is no onOrganizerLoad
// hook (the chrome:// scope does not expose Zotero.SmartOrganizer).

const DEBUG_MENU_ID = `${config.addonRef}-read-library`;
const ORGANIZE_MENU_ID = `${config.addonRef}-organize`;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await registerPrefs();

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerDebugMenu();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  Zotero.MenuManager.unregisterMenu(DEBUG_MENU_ID);
  Zotero.MenuManager.unregisterMenu(ORGANIZE_MENU_ID);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Preference UI events.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

/**
 * Register the Tools menu items.
 *
 * - "Smart Organizer: Read Library (debug)" — Gate 2's read-only diagnostic.
 *   Kept as-is per the work order.
 * - "Smart Organizer: Organize Library" — Gate 4's entry point. Runs
 *   `generatePlan()` (LLM call) and opens the review window. Replaces Gate 3's
 *   "Run Categorization (debug)" item.
 */
function registerDebugMenu(): void {
  Zotero.MenuManager.registerMenu({
    menuID: DEBUG_MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menu-readLibrary`,
        onCommand: () => {
          void runDebugReadLibrary();
        },
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: ORGANIZE_MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menu-organize`,
        onCommand: () => {
          void openReviewWindow();
        },
      },
    ],
  });
}

/**
 * Run the read-only library reader and report a summary via Zotero.debug and a
 * progress notification. Performs NO writes, NO LLM calls.
 */
async function runDebugReadLibrary(): Promise<void> {
  const progressWin = new Zotero.ProgressWindow();
  progressWin.changeHeadline("Smart Organizer: Reading library…");
  progressWin.show();

  let summary: LibrarySummary;
  try {
    const items = await readLibrary();
    summary = summarizeLibrary(items);
    Zotero.debug(
      `[SmartOrganizer] readLibrary: ${JSON.stringify(summary, null, 2)}`,
    );
  } catch (e) {
    Zotero.debug(`[SmartOrganizer] readLibrary failed: ${String(e)}`);
    progressWin.addDescription(`Error: ${(e as Error).message}`);
    progressWin.startCloseTimer(8000);
    return;
  }

  const lines = [
    `Total regular items: ${summary.total}`,
    `With abstract: ${summary.withAbstract}`,
    `With DOI: ${summary.withDoi}`,
    `With >=1 tag: ${summary.withTag}`,
    `With >=1 attachment: ${summary.withAttachment}`,
    `Unfiled (no collections): ${summary.unfiled}`,
    "Top 5 collection paths:",
    ...summary.topCollectionPaths.map(
      (p) => `  ${p.count}\t${p.path}`,
    ),
  ];
  for (const line of lines) {
    Zotero.debug(`[SmartOrganizer] ${line}`);
  }

  progressWin.addDescription(`Read ${summary.total} items.`);
  progressWin.startCloseTimer(4000);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
