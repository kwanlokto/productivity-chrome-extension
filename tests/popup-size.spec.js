// The popup is a fixed 340 × 420px on every tab and view (see README "Notes"),
// so it never jumps in size, and nothing in it overflows.

import { test, expect } from "./fixtures.js";

const POPUP_SIZE = { width: 340, height: 420 };

/**
 * The popup's rendered size. Size has no role or label, so measure the page
 * body, which Chrome sizes the popup window to.
 */
async function popupSize(popup) {
  const { width, height } = await popup.locator("body").boundingBox();
  return { width, height };
}

/** Whether the visible tab panel's content is taller than the panel. */
function panelOverflows(popup) {
  return popup.evaluate(() => {
    const panel = document.querySelector(".panel.is-active");
    return panel.scrollHeight > panel.clientHeight;
  });
}

test("the popup is 340 × 420 on every tab and view", async ({ openPopup }) => {
  const popup = await openPopup();

  const views = [
    ["Sites", async () => {}],
    ["Sites → Blocked sites", () =>
      popup.getByRole("button", { name: /^Blocked sites/ }).click()],
    ["YouTube", () => popup.getByRole("tab", { name: "YouTube" }).click()],
    ["YouTube → Allowed channels", () =>
      popup.getByRole("button", { name: /^Allowed channels/ }).click()],
    ["Settings", () => popup.getByRole("tab", { name: "Settings" }).click()],
  ];
  for (const [view, open] of views) {
    await open();
    await expect.poll(() => popupSize(popup), { message: view }).toEqual(POPUP_SIZE);
    expect(await panelOverflows(popup), view).toBe(false);
  }
});

test("the Sites tab is the same size in every state of the circle", async ({
  openPopup,
}) => {
  const now = Date.now();
  const unlocked = { "facebook.com": { start: now, expiry: now + 300_000, cap: 300_000 } };
  const states = [
    ["on a blocked site", { activeTab: { url: "https://facebook.com/" } }],
    ["unlocked", { activeTab: { url: "https://facebook.com/" }, local: { snoozed: unlocked } }],
    ["on a site that isn't blocked", { activeTab: { url: "https://twitch.tv/" } }],
    ["on a page that can't be blocked", { activeTab: { url: "chrome://newtab/", title: "New Tab" } }],
    ["switched off", { local: { pausedUntil: now + 600_000 } }],
  ];
  for (const [state, seed] of states) {
    const popup = await openPopup(seed);
    await expect.poll(() => popupSize(popup), { message: state }).toEqual(POPUP_SIZE);
    expect(await panelOverflows(popup), state).toBe(false);
    await popup.close();
  }
});

test("a long blocked-sites list scrolls on its own, keeping Back in view", async ({
  openPopup,
}) => {
  const blockedDomains = Array.from({ length: 30 }, (_, i) => `site${i + 1}.com`);
  const popup = await openPopup({ sync: { blockedDomains } });

  await popup.getByRole("button", { name: /^Blocked sites/ }).click();

  await expect(popup.getByText("site1.com", { exact: true })).toBeInViewport();
  await expect(popup.getByText("site30.com", { exact: true })).not.toBeInViewport();

  // Scrolling to the end moves only the list: Back and the Add field stay put.
  await popup.getByText("site30.com", { exact: true }).scrollIntoViewIfNeeded();
  await expect(popup.getByText("site30.com", { exact: true })).toBeInViewport();
  await expect(popup.getByText("site1.com", { exact: true })).not.toBeInViewport();
  await expect(popup.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
  await expect(popup.getByPlaceholder("Add a site, e.g. reddit.com")).toBeInViewport();
  await expect.poll(() => popupSize(popup)).toEqual(POPUP_SIZE);
});

test("the popup follows Chrome's light or dark setting", async ({ openPopup }) => {
  const popup = await openPopup();
  const background = () =>
    popup.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await popup.emulateMedia({ colorScheme: "light" });
  await expect.poll(background).toBe("rgb(244, 246, 250)");

  await popup.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).toBe("rgb(15, 20, 34)");
});
