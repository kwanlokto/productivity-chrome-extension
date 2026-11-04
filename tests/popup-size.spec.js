// The popup is a fixed 340 × 560px on every tab and view (see README "Notes"),
// so it never jumps in size as you switch tabs.

import { test, expect } from "./fixtures.js";

const POPUP_SIZE = { width: 340, height: 560 };

/**
 * The popup's rendered size. Size has no role or label, so measure the page
 * body, which Chrome sizes the popup window to.
 */
async function popupSize(popup) {
  const { width, height } = await popup.locator("body").boundingBox();
  return { width, height };
}

test("the popup is 340 × 560 on every tab and view", async ({ openPopup }) => {
  const popup = await openPopup();

  const views = [
    ["Main", async () => {}],
    ["Main → Change blocked sites", () =>
      popup.getByRole("button", { name: "Change blocked sites" }).click()],
    ["YouTube", () => popup.getByRole("tab", { name: "YouTube" }).click()],
    ["YouTube → Change allowed channels", () =>
      popup.getByRole("button", { name: "Change allowed channels" }).click()],
    ["Settings", () => popup.getByRole("tab", { name: "Settings" }).click()],
  ];
  for (const [view, open] of views) {
    await open();
    await expect.poll(() => popupSize(popup), { message: view }).toEqual(POPUP_SIZE);
  }
});

test("a long blocked-sites list scrolls on its own, keeping Back in view", async ({
  openPopup,
}) => {
  const blockedDomains = Array.from({ length: 30 }, (_, i) => `site${i + 1}.com`);
  const popup = await openPopup({ sync: { blockedDomains } });

  await popup.getByRole("button", { name: "Change blocked sites" }).click();

  await expect(popup.getByText("site1.com", { exact: true })).toBeInViewport();
  await expect(popup.getByText("site30.com", { exact: true })).not.toBeInViewport();

  // Scrolling to the end moves only the list: Back and the Add field stay put.
  await popup.getByText("site30.com", { exact: true }).scrollIntoViewIfNeeded();
  await expect(popup.getByText("site30.com", { exact: true })).toBeInViewport();
  await expect(popup.getByText("site1.com", { exact: true })).not.toBeInViewport();
  await expect(popup.getByRole("button", { name: "Back" })).toBeInViewport();
  await expect(popup.getByPlaceholder("add a domain, e.g. reddit.com")).toBeInViewport();
  await expect.poll(() => popupSize(popup)).toEqual(POPUP_SIZE);
});
