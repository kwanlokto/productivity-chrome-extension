// Settings tab: how long the header switch turns Focus Guard off for.

import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.js";

/** Open the popup (seeding storage) and switch to the Settings tab. */
async function openSettings(openPopup, seed) {
  const popup = await openPopup(seed);
  await popup.getByRole("tab", { name: "Settings" }).click();
  return popup;
}

test("Settings shows the disable duration, 15 minutes by default", async ({ openPopup }) => {
  const popup = await openSettings(openPopup);

  await expect(popup.getByRole("heading", { name: "Disable duration" })).toBeVisible();
  await expect(
    popup.getByRole("spinbutton", { name: "Disable duration in minutes" }),
  ).toHaveValue("15");
});

test("changing the duration saves it, and the switch offers the new length", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openSettings(openPopup);
  const input = popup.getByRole("spinbutton", { name: "Disable duration in minutes" });

  await input.fill("40");
  await input.press("Enter");

  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 40 min" }),
  ).toBeChecked();
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 40 });
});

test("a duration changed elsewhere (e.g. another synced device) shows up", async ({
  openPopup,
  background,
}) => {
  const popup = await openSettings(openPopup);

  await background.evaluate(() => chrome.storage.sync.set({ pauseMinutes: 33 }));

  await expect(
    popup.getByRole("spinbutton", { name: "Disable duration in minutes" }),
  ).toHaveValue("33");
});

test("out-of-range durations are clamped to 1–1440, and an empty one reverts", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 30 } });
  const input = popup.getByRole("spinbutton", { name: "Disable duration in minutes" });

  await input.fill("0");
  await input.press("Enter");
  await expect(input).toHaveValue("1");
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 1 });

  await input.fill("5000");
  await input.press("Enter");
  await expect(input).toHaveValue("1440");
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 1440 });

  await input.fill("");
  await input.press("Enter");
  await expect(input).toHaveValue("1440");
});

test("Save settings includes the disable duration", async ({ openPopup }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 25 } });

  const downloading = popup.waitForEvent("download");
  await popup.getByRole("button", { name: "Save settings" }).click();
  const file = await readFile(await (await downloading).path(), "utf8");

  expect(JSON.parse(file)).toMatchObject({ pauseMinutes: 25 });
});

/** Pick a settings file through the "Load settings" button's file chooser. */
async function loadSettingsFile(popup, settings) {
  const choosing = popup.waitForEvent("filechooser");
  await popup.getByRole("button", { name: "Load settings" }).click();
  await (await choosing).setFiles({
    name: "focus-guard-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(settings)),
  });
}

test("Load settings restores the disable duration", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup);

  await loadSettingsFile(popup, { pauseMinutes: 45 });

  await expect(
    popup.getByRole("spinbutton", { name: "Disable duration in minutes" }),
  ).toHaveValue("45");
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 45 });
});

test("Load settings ignores an invalid disable duration", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 20 } });

  await loadSettingsFile(popup, { unlockMinutes: 7, pauseMinutes: "lots" });

  await expect(popup.getByText("Settings loaded.")).toBeVisible();
  expect(await readStorage("sync", ["unlockMinutes", "pauseMinutes"])).toEqual({
    unlockMinutes: 7,
    pauseMinutes: 20,
  });
});

test("Reset puts the disable duration back to 15 minutes", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 50 } });

  await popup.getByRole("button", { name: "Reset" }).click();
  await popup.getByRole("button", { name: "Click again to confirm" }).click();

  await expect(
    popup.getByRole("spinbutton", { name: "Disable duration in minutes" }),
  ).toHaveValue("15");
  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked();
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 15 });
});
