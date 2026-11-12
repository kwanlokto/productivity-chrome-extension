// The notification: when an unlock reaches its last 30 seconds and the popup
// can't open over the site (Chrome is minimized, behind another app, or full
// screen), a desktop notification says when the site blocks again, once per
// unlock, and clears itself when it no longer applies.
//
// The background's chrome.notifications.create is wrapped to record what it
// shows (the API can't read a notification back), and chrome.action.openPopup
// is swapped for a counter. Clicks on a notification are simulated by
// dispatching the notifications events.

import { test, expect, unlockSite } from "./fixtures.js";

const SITE = "https://news.test/";
const OTHER = "https://other.test/";
const ID = "ending:news.test";

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

/** Record the notifications the background shows, and count popup openings. */
function watch(background) {
  return background.evaluate(() => {
    globalThis.created = [];
    const create = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (id, options) => {
      globalThis.created.push({ id, ...options });
      return create(id, options);
    };
    globalThis.popupsOpened = 0;
    chrome.action.openPopup = async () => {
      globalThis.popupsOpened++;
    };
  });
}

/** Every notification the background has shown, as { id, title, … }. */
const created = (background) => background.evaluate(() => globalThis.created);
/** The ids of the notifications on screen now. */
const onScreen = (background) =>
  background.evaluate(async () => Object.keys(await chrome.notifications.getAll()));
const popupsOpened = (background) => background.evaluate(() => globalThis.popupsOpened);

/** Minimize, restore, or full-screen the test window. */
function setWindowState(background, state) {
  return background.evaluate(async (state) => {
    const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
    await chrome.windows.update(win.id, state === "normal" ? { state, focused: true } : { state });
  }, state);
}

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

test("with Chrome minimized, a notification says the site blocks again in 30 seconds", async ({
  context,
  background,
}) => {
  await openSite(context);
  await watch(background);
  await setWindowState(background, "minimized");

  await unlockSite(background, "news.test", 31_000);

  await expect.poll(() => onScreen(background)).toEqual([ID]);
  const [note] = await created(background);
  expect(note).toMatchObject({
    title: "news.test blocks again in 30 seconds",
    message: "Click to go back to it.",
    buttons: [{ title: "+1 min" }],
    priority: 0,
  });
  expect(await popupsOpened(background)).toBe(0);
});

test("clicking it brings Chrome back to the site, where the popup opens", async ({
  context,
  background,
}) => {
  await openSite(context);
  await watch(background);
  await setWindowState(background, "minimized");
  await unlockSite(background, "news.test", 20_000);
  await expect.poll(() => onScreen(background)).toEqual([ID]);

  await background.evaluate((id) => chrome.notifications.onClicked.dispatch(id), ID);

  await expect.poll(() => popupsOpened(background)).toBe(1);
  expect(await onScreen(background)).toEqual([]);
  const win = await background.evaluate(() => chrome.windows.getLastFocused());
  expect(win.focused).toBe(true);
});

test("+1 min on it extends the unlock, and it doesn't come back", async ({
  context,
  background,
  readStorage,
}) => {
  const page = await openSite(context);
  await watch(background);
  await setWindowState(background, "minimized");
  // A 32-second unlock, so "+1 min" can only take it back to 32 seconds left.
  await unlockSite(background, "news.test", 20_000, { cap: 32_000 });
  await expect.poll(() => onScreen(background)).toEqual([ID]);
  const { snoozed: before } = await readStorage("local", "snoozed");

  await background.evaluate((id) => chrome.notifications.onButtonClicked.dispatch(id, 0), ID);

  await expect
    .poll(async () => (await readStorage("local", "snoozed")).snoozed["news.test"].expiry)
    .toBeGreaterThan(before["news.test"].expiry + 10_000);
  expect(await onScreen(background)).toEqual([]);
  await expect.poll(() => badge(background)).toMatch(/^3[12]s$/);
  await waitPastTheMark(page, background);
  expect(await created(background)).toHaveLength(1);
  expect(await onScreen(background)).toEqual([]);
});

test("in full screen it's urgent, and leaving full screen opens the popup and clears it", async ({
  context,
  background,
}) => {
  await openSite(context);
  await watch(background);
  await setWindowState(background, "fullscreen");

  await unlockSite(background, "news.test", 20_000);

  await expect.poll(() => onScreen(background)).toEqual([ID]);
  const [note] = await created(background);
  expect(note).toMatchObject({ message: "Click to leave full screen.", priority: 2 });
  expect(await popupsOpened(background)).toBe(0);

  await setWindowState(background, "normal");

  await expect.poll(() => popupsOpened(background)).toBe(1);
  await expect.poll(() => onScreen(background)).toEqual([]);
});

test("it doesn't show while you're in Chrome on another tab", async ({ context, background }) => {
  const site = await openSite(context);
  await openSite(context, OTHER);
  await watch(background);

  await unlockSite(background, "news.test", 20_000);
  await waitPastTheMark(site, background);

  expect(await created(background)).toEqual([]);
  expect(await popupsOpened(background)).toBe(0);
});

test("it doesn't show when the site isn't the tab showing in its window", async ({
  context,
  background,
}) => {
  const site = await openSite(context);
  await openSite(context, OTHER);
  await watch(background);
  await setWindowState(background, "minimized");

  await unlockSite(background, "news.test", 20_000);
  await waitPastTheMark(site, background);

  expect(await created(background)).toEqual([]);
});

test("once the popup has opened, leaving Chrome doesn't add a notification", async ({
  context,
  background,
}) => {
  const page = await openSite(context);
  await watch(background);
  await unlockSite(background, "news.test", 20_000);
  await expect.poll(() => popupsOpened(background)).toBe(1);

  await setWindowState(background, "minimized");
  await page.waitForTimeout(1_500);

  expect(await created(background)).toEqual([]);
});

test("hiding the warning bar keeps it from showing", async ({ context, background }) => {
  const page = await openSite(context);
  await watch(background);
  await unlockSite(background, "news.test", 35_000);
  await page.getByRole("button", { name: "Hide this warning" }).click();

  await setWindowState(background, "minimized");
  await waitPastTheMark(page, background);

  expect(await created(background)).toEqual([]);
});

test("it clears itself when the unlock ends", async ({ context, background }) => {
  await openSite(context);
  await watch(background);
  await setWindowState(background, "minimized");
  await unlockSite(background, "news.test", 20_000);
  await expect.poll(() => onScreen(background)).toEqual([ID]);

  // What Block now in the popup does to storage.
  await background.evaluate(() => chrome.storage.local.set({ snoozed: {} }));

  await expect.poll(() => onScreen(background)).toEqual([]);
});

test("it clears itself when Focus Guard is switched off", async ({ context, background }) => {
  await openSite(context);
  await watch(background);
  await setWindowState(background, "minimized");
  await unlockSite(background, "news.test", 20_000);
  await expect.poll(() => onScreen(background)).toEqual([ID]);

  await background.evaluate(() =>
    chrome.storage.local.set({ pausedUntil: Date.now() + 10 * 60_000 }),
  );

  await expect.poll(() => onScreen(background)).toEqual([]);
});
