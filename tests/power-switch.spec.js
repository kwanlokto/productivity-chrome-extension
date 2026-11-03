// The header on/off switch: turning all of Focus Guard off for a while.

import { test, expect } from "./fixtures.js";

/**
 * Everything below the header. Dimming is purely visual (no role or label
 * exposes it), so this is the one place these tests reach for an id.
 */
const belowHeader = (popup) => popup.locator("#app-body");

/**
 * The Main tab's circle while it reads "Off". `includeHidden` because the
 * dimmed area is `inert`, which hides it from the accessibility tree.
 */
const offCircle = (popup) =>
  popup.getByRole("button", { name: "Off", exact: true, includeHidden: true });

test("the switch is on by default and offers a 15-minute break", async ({ openPopup }) => {
  const popup = await openPopup();

  const power = popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" });
  await expect(power).toBeChecked();
  await expect(power).toHaveAttribute("title", "Turn Focus Guard off for 15 min");
});

test("the switch offers the break length set in Settings", async ({ openPopup }) => {
  const popup = await openPopup({ sync: { pauseMinutes: 40 } });

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 40 min" }),
  ).toBeChecked();
});

test("flipping the switch off turns Focus Guard off for the set minutes", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openPopup();
  const before = Date.now();

  await popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }).click();

  const power = popup.getByRole("switch", { name: "Turn Focus Guard back on" });
  await expect(power).not.toBeChecked();
  await expect(power).toHaveAttribute("title", "Turn Focus Guard back on");
  await expect(popup.getByText(/^1[45]:\d\d left$/)).toBeVisible();

  const { pausedUntil } = await readStorage("local", "pausedUntil");
  expect(pausedUntil).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(pausedUntil).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
});

test("flipping the switch back on turns Focus Guard on straight away", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });

  await popup.getByRole("switch", { name: "Turn Focus Guard back on" }).click();

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked();
  await expect(popup.getByText(/^\d+:\d\d left$/)).toBeHidden();
  await expect(belowHeader(popup)).toHaveCSS("opacity", "1");
  await expect(offCircle(popup)).toHaveCount(0);
  expect(await readStorage("local", "pausedUntil")).toEqual({});
});

test("when the time runs out, the open popup turns back on by itself", async ({
  openPopup,
}) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 3_000 } });
  await expect(popup.getByRole("switch", { name: "Turn Focus Guard back on" })).toBeVisible();

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked({ timeout: 6_000 });
  await expect(belowHeader(popup)).toHaveCSS("opacity", "1");
  await expect(offCircle(popup)).toHaveCount(0);
});

test("when the resume alarm ends the pause, the open popup turns back on", async ({
  openPopup,
  background,
}) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });
  await expect(popup.getByRole("switch", { name: "Turn Focus Guard back on" })).toBeVisible();

  // What the background does when the "fg-pause-end" alarm fires.
  await background.evaluate(() => chrome.storage.local.remove("pausedUntil"));

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked();
  await expect(belowHeader(popup)).toHaveCSS("opacity", "1");
});

test("while off, everything below the header is dimmed and can't be used", async ({
  openPopup,
}) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });
  await expect(popup.getByRole("switch", { name: "Turn Focus Guard back on" })).toBeVisible();

  await expect(belowHeader(popup)).toHaveCSS("opacity", "0.4");

  // Clicking another tab doesn't switch to it. (`includeHidden`: see offCircle.)
  const youtubeTab = popup.getByRole("tab", { name: "YouTube", includeHidden: true });
  await youtubeTab.click({ force: true });
  await expect(youtubeTab).toHaveAttribute("aria-selected", "false");

  // Controls can't take keyboard focus.
  const manageBtn = popup.getByRole("button", {
    name: "Change blocked sites",
    includeHidden: true,
  });
  await manageBtn.focus();
  await expect(manageBtn).not.toBeFocused();
});

test("while off, the Main tab's circle just says Off", async ({ openPopup }) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });

  await expect(offCircle(popup)).toBeVisible();
});

test("the Main tab no longer has its own Disable controls", async ({ openPopup }) => {
  const popup = await openPopup();
  await expect(popup.getByRole("switch")).toHaveCount(1);

  await expect(popup.getByText("Disable Focus Guard")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Disable", exact: true })).toHaveCount(0);
});
