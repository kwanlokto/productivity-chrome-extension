// The popup opens by itself when an unlock has 30 seconds or less left: once
// per unlock, only over the site's own tab, in the window in front, not in full
// screen, not after the warning bar was hidden, and not while Focus Guard is off.
//
// Most tests swap chrome.action.openPopup in the background for a counter, so
// they can tell how many times it would have opened. The first one opens the
// real popup.

import { test, expect, unlockSite } from "./fixtures.js";

const SITE = "https://news.test/";
const OTHER = "https://other.test/";

test.beforeEach(async ({ context }) => {
  // Serve the test sites locally so they load without a network.
  await context.route(/^https:\/\/(news|other)\.test\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Test page</title><h1>Test</h1>" }),
  );
});

/** Open a site in a new tab. */
async function openSite(context, url = SITE) {
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/** Count the background's attempts to open the popup, instead of opening it. */
function countPopups(background) {
  return background.evaluate(() => {
    globalThis.popupsOpened = 0;
    chrome.action.openPopup = async () => {
      globalThis.popupsOpened++;
    };
  });
}

const popupsOpened = (background) => background.evaluate(() => globalThis.popupsOpened);

/** The test site's badge: proof the background has caught up. */
function badge(background) {
  return background.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, SITE + "*");
}

/** Wait until the unlock is under 30 seconds, then give the background a tick. */
async function waitPastTheMark(page, background) {
  await expect.poll(() => badge(background), { timeout: 10_000 }).toMatch(/^([12]?\d)s$/);
  await page.waitForTimeout(1_500);
}

/** The window the test pages are in. */
function setWindowState(background, state) {
  return background.evaluate(async (state) => {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    await chrome.windows.update(win.id, { state });
  }, state);
}

test("with 30 seconds left, the popup opens over the unlocked site", async ({
  context,
  background,
}) => {
  await openSite(context);

  await unlockSite(background, "news.test", 20_000);

  await expect
    .poll(() =>
      background.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ["POPUP"] })).length,
      ),
    )
    .toBe(1);
});

test("it doesn't open before the last 30 seconds", async ({ context, background }) => {
  const page = await openSite(context);
  await countPopups(background);

  await unlockSite(background, "news.test", 45_000);

  await expect.poll(() => badge(background)).toMatch(/^4\ds$/);
  await page.waitForTimeout(1_500);
  expect(await popupsOpened(background)).toBe(0);
});

test("it opens only once per unlock, even after +1 min", async ({ context, background }) => {
  const page = await openSite(context);
  await countPopups(background);
  // A 32-second unlock, so "+1 min" can only take it back to 32 seconds left.
  await unlockSite(background, "news.test", 20_000, { cap: 32_000 });
  await expect.poll(() => popupsOpened(background)).toBe(1);

  await page.getByRole("button", { name: "+1 min" }).click();
  await expect.poll(() => badge(background)).toMatch(/^3[12]s$/);

  await waitPastTheMark(page, background);
  expect(await popupsOpened(background)).toBe(1);
});

test("over another tab it waits, and opens when you switch to the site", async ({
  context,
  background,
}) => {
  const site = await openSite(context);
  const other = await openSite(context, OTHER);
  await countPopups(background);

  await unlockSite(background, "news.test", 20_000);

  await waitPastTheMark(other, background);
  expect(await popupsOpened(background)).toBe(0);

  await site.bringToFront();
  await expect.poll(() => popupsOpened(background)).toBe(1);
});

test("in full screen it waits, and opens when you leave full screen", async ({
  context,
  background,
}) => {
  const page = await openSite(context);
  await countPopups(background);
  await setWindowState(background, "fullscreen");

  await unlockSite(background, "news.test", 20_000);

  await waitPastTheMark(page, background);
  expect(await popupsOpened(background)).toBe(0);

  await setWindowState(background, "normal");
  await expect.poll(() => popupsOpened(background)).toBe(1);
});

test("hiding the warning bar keeps the popup from opening", async ({ context, background }) => {
  const page = await openSite(context);
  await countPopups(background);
  await unlockSite(background, "news.test", 35_000);

  await page.getByRole("button", { name: "Hide this warning" }).click();

  await waitPastTheMark(page, background);
  expect(await popupsOpened(background)).toBe(0);
});

test("while Focus Guard is off it waits, and opens when it's back on", async ({
  context,
  background,
}) => {
  const page = await openSite(context);
  await countPopups(background);

  await unlockSite(background, "news.test", 20_000, {
    local: { pausedUntil: Date.now() + 10 * 60_000 },
  });

  await page.waitForTimeout(1_500);
  expect(await popupsOpened(background)).toBe(0);

  await background.evaluate(() => chrome.storage.local.remove("pausedUntil"));
  await expect.poll(() => popupsOpened(background)).toBe(1);
});

test("if the popup is already open, that counts as its one time", async ({
  context,
  background,
  readStorage,
}) => {
  const page = await openSite(context);
  // The user opened the popup themselves.
  await background.evaluate(() => chrome.action.openPopup());
  await countPopups(background);

  await unlockSite(background, "news.test", 20_000);

  await expect
    .poll(() => background.evaluate(() => chrome.storage.session.get("popupOpened")))
    .toHaveProperty(["popupOpened", "news.test"]);
  await page.waitForTimeout(1_000);
  expect(await popupsOpened(background)).toBe(0);
});
