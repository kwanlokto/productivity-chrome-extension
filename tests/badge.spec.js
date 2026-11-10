// The toolbar badge: while a site is unlocked, its tabs show the time left on
// the Focus Guard icon, in amber, then in red for the last minute.

import { test, expect, unlockSite } from "./fixtures.js";

const UNLOCKED = "https://news.test/";
const OTHER = "https://other.test/";

const AMBER = [245, 158, 11, 255];
const RED = [220, 38, 38, 255];

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

/** The badge's background colour on a tab, as [r, g, b, a]. */
function badgeColorOf(background, tabId) {
  return background.evaluate(
    (tabId) => chrome.action.getBadgeBackgroundColor({ tabId }),
    tabId,
  );
}

test("an unlocked site's tabs show the minutes left in amber, and other tabs show nothing", async ({
  context,
  background,
}) => {
  const news = await openSite(context, background, UNLOCKED);
  const other = await openSite(context, background, OTHER);

  await unlockSite(background, "news.test", 5 * 60_000);

  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");
  expect(await badgeColorOf(background, news.tabId)).toEqual(AMBER);
  expect(await badgeOf(background, other.tabId)).toBe("");
});

test("in the last minute the badge counts seconds in red", async ({ context, background }) => {
  const news = await openSite(context, background, UNLOCKED);

  await unlockSite(background, "news.test", 40_000);

  await expect.poll(() => badgeOf(background, news.tabId)).toMatch(/^(40|39|38|37)s$/);
  expect(await badgeColorOf(background, news.tabId)).toEqual(RED);
});

test("the badge clears when the unlock ends", async ({ context, background }) => {
  const news = await openSite(context, background, UNLOCKED);

  await unlockSite(background, "news.test", 4_000);

  await expect.poll(() => badgeOf(background, news.tabId)).toMatch(/^[1-4]s$/);
  await expect.poll(() => badgeOf(background, news.tabId), { timeout: 8_000 }).toBe("");
});

test("the badge clears when the tab leaves the unlocked site", async ({
  context,
  background,
}) => {
  const news = await openSite(context, background, UNLOCKED);
  await unlockSite(background, "news.test", 5 * 60_000);
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");

  await news.page.goto(OTHER);

  await expect.poll(() => badgeOf(background, news.tabId)).toBe("");
});

test("there's no badge while Focus Guard is off", async ({ context, background }) => {
  const news = await openSite(context, background, UNLOCKED);

  await unlockSite(background, "news.test", 5 * 60_000, {
    local: { pausedUntil: Date.now() + 10 * 60_000 },
  });
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("");

  await background.evaluate(() => chrome.storage.local.remove("pausedUntil"));
  await expect.poll(() => badgeOf(background, news.tabId)).toBe("5m");
});

test("the old popup-reopening alarm is gone", async ({ background }) => {
  await unlockSite(background, "news.test", 40_000);

  const alarms = await background.evaluate(() => chrome.alarms.getAll());
  expect(alarms.map((a) => a.name)).not.toContain("open-30");
});
