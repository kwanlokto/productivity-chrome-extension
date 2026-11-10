// The warning bar: in an unlock's last minute, the unlocked site shows "… blocks
// again in 0:42" with "+1 min" and a way to hide it.

import { test, expect, unlockSite } from "./fixtures.js";

const SITE = "https://news.test/";

test.beforeEach(async ({ context }) => {
  // Serve the test site locally so it loads without a network.
  await context.route(/^https:\/\/news\.test\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>News</title><h1>News</h1>" }),
  );
});

/** Open the test site in a new tab. */
async function openSite(context) {
  const page = await context.newPage();
  await page.goto(SITE);
  return page;
}

const bar = (page) => page.getByText(/^news\.test blocks again in 0:\d\d$/);

/** The badge text on the test site's tab: proof the background has caught up. */
function badge(background) {
  return background.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, SITE + "*");
}

test("in the last minute, the unlocked site shows a warning bar", async ({
  context,
  background,
}) => {
  const page = await openSite(context);

  await unlockSite(background, "news.test", 40_000);

  await expect(bar(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "+1 min" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Hide this warning" })).toBeVisible();
});

test("there's no bar before the last minute", async ({ context, background }) => {
  const page = await openSite(context);

  await unlockSite(background, "news.test", 5 * 60_000);

  await expect.poll(() => badge(background)).toBe("5m");
  await expect(page.getByText(/blocks again in/)).toHaveCount(0);
});

test("+1 min on the bar extends the unlock, and the bar waits for the last minute again", async ({
  context,
  background,
  readStorage,
}) => {
  const page = await openSite(context);
  await unlockSite(background, "news.test", 30_000);
  await expect(bar(page)).toBeVisible();
  const { snoozed: before } = await readStorage("local", "snoozed");

  await page.getByRole("button", { name: "+1 min" }).click();

  await expect
    .poll(async () => (await readStorage("local", "snoozed")).snoozed["news.test"].expiry)
    .toBe(before["news.test"].expiry + 60_000);
  await expect(bar(page)).toBeHidden();
});

test("hiding the bar keeps it hidden for the rest of the unlock, even after a reload", async ({
  context,
  background,
}) => {
  const page = await openSite(context);
  await unlockSite(background, "news.test", 40_000);
  await expect(bar(page)).toBeVisible();

  await page.getByRole("button", { name: "Hide this warning" }).click();
  await expect(bar(page)).toBeHidden();

  await page.reload();
  await expect.poll(() => badge(background)).toMatch(/s$/);
  await page.waitForTimeout(1_000); // give the background time to (not) add it
  await expect(page.getByText(/blocks again in/)).toHaveCount(0);
});

test("a new page on the site in the last minute gets the bar too", async ({
  context,
  background,
}) => {
  const page = await openSite(context);
  await unlockSite(background, "news.test", 40_000);
  await expect(bar(page)).toBeVisible();

  await page.goto(SITE + "another-article");

  await expect(bar(page)).toBeVisible();
});

test("the bar goes away when Focus Guard is switched off", async ({ context, background }) => {
  const page = await openSite(context);
  await unlockSite(background, "news.test", 40_000);
  await expect(bar(page)).toBeVisible();

  await background.evaluate(() =>
    chrome.storage.local.set({ pausedUntil: Date.now() + 10 * 60_000 }),
  );

  await expect(bar(page)).toBeHidden();
});

test("the bar goes away when the unlock is ended early", async ({ context, background }) => {
  const page = await openSite(context);
  await unlockSite(background, "news.test", 40_000);
  await expect(bar(page)).toBeVisible();

  // What Block now in the popup does to storage.
  await background.evaluate(() => chrome.storage.local.set({ snoozed: {} }));

  await expect(bar(page)).toBeHidden();
});

test("the bar keeps its look on a site with a strict Content Security Policy", async ({
  context,
  background,
}) => {
  await context.route("https://news.test/strict", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "default-src 'none'; style-src 'none'" },
      body: "<title>Strict</title><h1>Strict</h1>",
    }),
  );
  const page = await context.newPage();
  await page.goto(SITE + "strict");

  await unlockSite(background, "news.test", 40_000);

  const region = page.getByRole("region", { name: "Focus Guard" });
  await expect(region).toBeVisible();
  await expect(region).toHaveCSS("height", "40px");
  await expect(region).toHaveCSS("border-radius", "999px");
});
