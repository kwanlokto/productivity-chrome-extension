// YouTube tab: the focus switches and the allowed-channels list.

import { test, expect } from "./fixtures.js";

/** Open the popup (seeding storage) and switch to the YouTube tab. */
async function openYoutube(openPopup, seed) {
  const popup = await openPopup(seed);
  await popup.getByRole("tab", { name: "YouTube" }).click();
  return popup;
}

test("the Allowed channels row says Off until the allow-list is on", async ({
  openPopup,
}) => {
  const popup = await openYoutube(openPopup);
  await expect(popup.getByRole("button", { name: "Allowed channels Off" })).toBeVisible();

  await popup.getByRole("button", { name: /^Allowed channels/ }).click();
  const allowlist = popup.getByRole("switch", { name: "Only allowed channels" });
  await expect(allowlist).toHaveAccessibleDescription("Off · every channel is shown");

  await allowlist.click();
  await expect(allowlist).toHaveAccessibleDescription("On · other channels are hidden");
  await popup.getByRole("button", { name: "Back", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Allowed channels 8 channels" })).toBeVisible();
});

test("channels can be added and removed while the allow-list is off", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openYoutube(openPopup, { sync: { allowedChannels: ["veritasium"] } });
  await popup.getByRole("button", { name: /^Allowed channels/ }).click();
  await expect(popup.getByRole("switch", { name: "Only allowed channels" })).not.toBeChecked();

  await popup.getByRole("textbox", { name: "Channel to allow" }).fill("@MITOCW");
  await popup.getByRole("button", { name: "Add" }).click();
  await expect(popup.getByRole("listitem").filter({ hasText: "@mitocw" })).toBeVisible();

  await popup.getByRole("button", { name: "Remove @veritasium" }).click();
  await expect(popup.getByRole("listitem")).toHaveCount(1);
  expect(await readStorage("sync", "allowedChannels")).toEqual({ allowedChannels: ["mitocw"] });
});

test("with YouTube focus off, the other switches and the channel list are locked", async ({
  openPopup,
}) => {
  const popup = await openYoutube(openPopup);

  await popup.getByRole("switch", { name: "YouTube focus" }).click();

  await expect(popup.getByRole("switch", { name: "Shorts" })).toBeDisabled();
  await expect(popup.getByRole("button", { name: /^Allowed channels/ })).toBeDisabled();
});
