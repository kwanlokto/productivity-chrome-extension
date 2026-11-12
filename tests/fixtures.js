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

/**
 * Put `domain` on the blocked list, unlocked with `msLeft` to go, the way the
 * popup leaves things after Unlock. The unlock is written before the list
 * changes, so the background's rule rebuild skips the domain instead of adding
 * a rule that would bounce the test page to the blocked page.
 * @param {import("@playwright/test").Worker} background
 * @param {string} domain
 * @param {number} msLeft
 * @param {{ cap?: number, local?: Record<string, unknown> }} [options]
 *   `cap` is the unlock's original length (default 5 minutes); `local` is more
 *   chrome.storage.local to set alongside.
 */
export function unlockSite(background, domain, msLeft, { cap = 5 * 60_000, local = {} } = {}) {
  return background.evaluate(
    async ({ domain, msLeft, cap, local }) => {
      const now = Date.now();
      await chrome.storage.local.set({
        ...local,
        snoozed: { [domain]: { start: now - (cap - msLeft), expiry: now + msLeft, cap } },
      });
      const { blockedDomains } = await chrome.storage.sync.get("blockedDomains");
      await chrome.storage.sync.set({ blockedDomains: [...blockedDomains, domain] });
    },
    { domain, msLeft, cap, local },
  );
}
