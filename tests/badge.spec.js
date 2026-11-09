// The toolbar badge: while a site is unlocked, its tabs show the time left on
// the Focus Guard icon. The popup never opens by itself.

import { test, expect } from "./fixtures.js";

const UNLOCKED = "https://news.test/";
const OTHER = "https://other.test/";

test.beforeEach(async ({ context }) => {
  // Serve the test sites locally so they load without a network.
  await context.route(/^https:\/\/(news|other)\.test\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Test page</title>" }),
  );
});

/** Open a site in a new tab and return the tab's id. */
async function openSite(context, background, url) {
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await background.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0].id,
    url,
  );
  return { page, tabId };
}

/** The badge text shown while a tab is active. */
function badgeOf(background, tabId) {
  return background.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
}

/**
 * Block news.test and unlock it with `msLeft` to go.
 * @param {import("@playwright/test").Worker} background
 * @param {number} msLeft
 * @param {Record<string, unknown>} [local] more chrome.storage.local to set
 */
function unlockNews(background, msLeft, local = {}) {
  return background.evaluate(
    async ({ msLeft, local }) => {
      const { blockedDomains } = await chrome.storage.sync.get("blockedDomains");
      await chrome.storage.sync.set({ blockedDomains: [...blockedDomains, "news.test"] });
      const now = Date.now();
      await chrome.storage.local.set({
        ...local,
        snoozed: { "news.test": { start: now, expiry: now + msLeft, cap: msLeft } },
      });
    },
    { msLeft, local },
  );
}

test("an unlocked site's tabs show the minutes left, and other tabs show nothing", async ({
  context,
  background,
}) => {
  const news = await openSite(context, background, UNLOCKED);
  const other = await openSite(context, background, OTHER);

  await unlockNews(background, 5 * 60_000);

  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");
  expect(await badgeOf(background, other.tabId)).toBe("");
});

test("in the last minute the badge counts seconds, then clears when the unlock ends", async ({
  context,
  background,
}) => {
  const news = await openSite(context, background, UNLOCKED);

  await unlockNews(background, 4_000);

  await expect.poll(() => badgeOf(background, news.tabId)).toMatch(/^[1-4]s$/);
  await expect.poll(() => badgeOf(background, news.tabId), { timeout: 8_000 }).toBe("");
});

test("the badge clears when the tab leaves the unlocked site", async ({
  context,
  background,
}) => {
  const news = await openSite(context, background, UNLOCKED);
  await unlockNews(background, 5 * 60_000);
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");

  await news.page.goto(OTHER);

  await expect.poll(() => badgeOf(background, news.tabId)).toBe("");
});

test("there's no badge while Focus Guard is off", async ({ context, background }) => {
  const news = await openSite(context, background, UNLOCKED);

  await unlockNews(background, 5 * 60_000, { pausedUntil: Date.now() + 10 * 60_000 });
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("");

  await background.evaluate(() => chrome.storage.local.remove("pausedUntil"));
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");
});

test("the background no longer schedules the popup to open", async ({ background }) => {
  await unlockNews(background, 40_000);

  const alarms = await background.evaluate(() => chrome.alarms.getAll());
  expect(alarms.map((a) => a.name)).not.toContain("open-30");
});
