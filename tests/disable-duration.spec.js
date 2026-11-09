// Settings tab: how long the header switch turns Focus Guard off for ("Break
// length"), and the − / + buttons beside both minute fields.

import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.js";

/** Open the popup (seeding storage) and switch to the Settings tab. */
async function openSettings(openPopup, seed) {
  const popup = await openPopup(seed);
  await popup.getByRole("tab", { name: "Settings" }).click();
  return popup;
}

const breakInput = (popup) =>
  popup.getByRole("spinbutton", { name: "Break length in minutes" });

test("Settings shows the break length, 15 minutes by default", async ({ openPopup }) => {
  const popup = await openSettings(openPopup);

  await expect(popup.getByRole("heading", { name: "Durations" })).toBeVisible();
  await expect(popup.getByText("Break length", { exact: true })).toBeVisible();
  await expect(breakInput(popup)).toHaveValue("15");
});

test("changing the break length saves it, and the switch offers the new length", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openSettings(openPopup);
  const input = breakInput(popup);

  await input.fill("40");
  await input.press("Enter");

  await expect(popup.getByText("Break length saved — 40 min.")).toBeVisible();
  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 40 min" }),
  ).toBeChecked();
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 40 });
});

test("a break length changed elsewhere (e.g. another synced device) shows up", async ({
  openPopup,
  background,
}) => {
  const popup = await openSettings(openPopup);

  await background.evaluate(() => chrome.storage.sync.set({ pauseMinutes: 33 }));

  await expect(breakInput(popup)).toHaveValue("33");
});

test("out-of-range lengths are clamped to 1–1440, and an empty one reverts", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 30 } });
  const input = breakInput(popup);

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

test("+ and − change a length by one minute and save it", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openSettings(openPopup, { sync: { unlockMinutes: 5 } });
  const unlock = popup.getByRole("spinbutton", { name: "Unlock length in minutes" });

  await popup.getByRole("button", { name: "Longer unlock" }).click();
  await popup.getByRole("button", { name: "Longer unlock" }).click();
  await expect(unlock).toHaveValue("7");
  await expect.poll(() => readStorage("sync", "unlockMinutes")).toEqual({ unlockMinutes: 7 });

  await popup.getByRole("button", { name: "Shorter break" }).click();
  await expect(breakInput(popup)).toHaveValue("14");
  await expect.poll(() => readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 14 });
});

test("− and + stop at 1 and 1440 minutes", async ({ openPopup }) => {
  const popup = await openSettings(openPopup, { sync: { unlockMinutes: 2, pauseMinutes: 1439 } });

  await popup.getByRole("button", { name: "Shorter unlock" }).click();
  await expect(
    popup.getByRole("spinbutton", { name: "Unlock length in minutes" }),
  ).toHaveValue("1");
  await expect(popup.getByRole("button", { name: "Shorter unlock" })).toBeDisabled();

  await popup.getByRole("button", { name: "Longer break" }).click();
  await expect(breakInput(popup)).toHaveValue("1440");
  await expect(popup.getByRole("button", { name: "Longer break" })).toBeDisabled();
});

test("Export settings includes the break length", async ({ openPopup }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 25 } });

  const downloading = popup.waitForEvent("download");
  await popup.getByRole("button", { name: "Export settings" }).click();
  const file = await readFile(await (await downloading).path(), "utf8");

  expect(JSON.parse(file)).toMatchObject({ pauseMinutes: 25 });
});

/** Pick a settings file through the "Import settings" button's file chooser. */
async function importSettingsFile(popup, settings) {
  const choosing = popup.waitForEvent("filechooser");
  await popup.getByRole("button", { name: "Import settings" }).click();
  await (await choosing).setFiles({
    name: "focus-guard-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(settings)),
  });
}

test("Import settings restores the break length", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup);

  await importSettingsFile(popup, { pauseMinutes: 45 });

  await expect(breakInput(popup)).toHaveValue("45");
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 45 });
});

test("Import settings ignores an invalid break length", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 20 } });

  await importSettingsFile(popup, { unlockMinutes: 7, pauseMinutes: "lots" });

  await expect(popup.getByText("Settings loaded.")).toBeVisible();
  expect(await readStorage("sync", ["unlockMinutes", "pauseMinutes"])).toEqual({
    unlockMinutes: 7,
    pauseMinutes: 20,
  });
});

test("Reset puts the break length back to 15 minutes", async ({ openPopup, readStorage }) => {
  const popup = await openSettings(openPopup, { sync: { pauseMinutes: 50 } });

  await popup.getByRole("button", { name: "Reset to defaults" }).click();
  await popup.getByRole("button", { name: "Click again to confirm" }).click();

  await expect(breakInput(popup)).toHaveValue("15");
  await expect(
    popup.getByRole("switch", { name: "Turn Focus Guard off for 15 min" }),
  ).toBeChecked();
  expect(await readStorage("sync", "pauseMinutes")).toEqual({ pauseMinutes: 15 });
});
