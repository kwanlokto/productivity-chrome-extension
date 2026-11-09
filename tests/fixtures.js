// Test fixtures: a fresh Chromium profile with Focus Guard loaded unpacked, plus
// helpers to seed chrome.storage and open the popup page in a tab.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect } from "@playwright/test";

const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const test = base.extend({
  context: async ({}, use) => {
    // The "chromium" channel runs the new headless mode, which supports extensions.
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },

  /** The extension's background service worker, once its install seeding is done. */
  background: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    // onInstalled seeds default settings; wait for it so it can't overwrite a
    // test's own seed (it only fills keys that are still unset when it runs).
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const { blockedDomains } = await chrome.storage.sync.get("blockedDomains");
          return blockedDomains !== undefined;
        }),
      )
      .toBe(true);
    await use(worker);
  },

  /**
   * Seed chrome.storage, then open the popup page in a new tab.
   * Usage: `const popup = await openPopup({ sync: {...}, local: {...} })`.
   *
   * Opened as a tab, the popup is its own active tab. Pass `activeTab`
   * (`{ url, title }`) to make it see that page as the active tab instead, so
   * the circle shows that page's state. The fake tab has no id, so actions that
   * navigate or reload the active tab skip that step.
   */
  openPopup: async ({ context, background }, use) => {
    const extensionId = background.url().split("/")[2];
    await use(async ({ sync = {}, local = {}, activeTab } = {}) => {
      await background.evaluate(
        async ({ sync, local }) => {
          await chrome.storage.sync.set(sync);
          await chrome.storage.local.set(local);
        },
        { sync, local },
      );
      const page = await context.newPage();
      if (activeTab) {
        await page.addInitScript((fake) => {
          const query = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (info) =>
            info?.active ? [{ active: true, ...fake }] : query(info);
        }, activeTab);
      }
      await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      return page;
    });
  },

  /** Read keys from chrome.storage ("sync" or "local") via the background. */
  readStorage: async ({ background }, use) => {
    await use((area, keys) =>
      background.evaluate(
        ({ area, keys }) => chrome.storage[area].get(keys),
        { area, keys },
      ),
    );
  },
});

export { expect };
