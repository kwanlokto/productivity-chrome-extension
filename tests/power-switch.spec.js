// The header on/off switch: turning all of Focus Guard off for a while.

import { test, expect } from "./fixtures.js";

/** The break countdown the Sites tab's circle shows while off. */
const breakCircle = (popup) =>
  popup.getByRole("button", { name: /^\d+:\d\d until back on$/ });

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
  await expect(popup.getByText("Focus Guard is off · nothing is blocked")).toBeVisible();
  await expect(breakCircle(popup)).toHaveAccessibleName(/^1[45]:\d\d until back on$/);

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
  await expect(breakCircle(popup)).toHaveCount(0);
  await expect(popup.getByRole("button", { name: /^Blocked sites/ })).toBeEnabled();
  expect(await readStorage("local", "pausedUntil")).toEqual({});
});

test("Turn on now ends the break", async ({ openPopup, readStorage }) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });

  await popup.getByRole("button", { name: "Turn on now" }).click();

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked();
  await expect(popup.getByRole("button", { name: "Turn on now" })).toBeHidden();
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
  await expect(breakCircle(popup)).toHaveCount(0);
  await expect(popup.getByRole("tab", { name: "YouTube" })).toBeVisible();
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
  await expect(breakCircle(popup)).toHaveCount(0);
});

test("while off, the tabs and the blocked-sites list can't be used", async ({
  openPopup,
}) => {
  const popup = await openPopup({ local: { pausedUntil: Date.now() + 10 * 60_000 } });
  await expect(popup.getByRole("switch", { name: "Turn Focus Guard back on" })).toBeVisible();

  // Clicking another tab doesn't switch to it. `includeHidden` because the tabs
  // are `inert`, which hides them from the accessibility tree.
  const youtubeTab = popup.getByRole("tab", { name: "YouTube", includeHidden: true });
  await youtubeTab.click({ force: true });
  await expect(youtubeTab).toHaveAttribute("aria-selected", "false");

  await expect(popup.getByRole("button", { name: /^Blocked sites/ })).toBeDisabled();
});

test("switching off from another tab shows the break on the Sites tab", async ({
  openPopup,
}) => {
  const popup = await openPopup();
  await popup.getByRole("tab", { name: "Settings" }).click();

  await popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }).click();

  await expect(
    popup.getByRole("tab", { name: "Sites", includeHidden: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(breakCircle(popup)).toBeVisible();
});

test("switching off closes the blocked-sites list", async ({ openPopup }) => {
  const popup = await openPopup();
  await popup.getByRole("button", { name: /^Blocked sites/ }).click();
  const back = popup.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeVisible();

  await popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }).click();

  await expect(breakCircle(popup)).toBeVisible();
  await expect(back).toBeHidden();
});

test("the Sites tab has no other on/off controls", async ({ openPopup }) => {
  const popup = await openPopup();
  await expect(popup.getByRole("switch")).toHaveCount(1);

  await expect(popup.getByText("Disable Focus Guard")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Disable", exact: true })).toHaveCount(0);
});
