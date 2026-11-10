// Sites tab: the circle for the current tab, and the blocked-sites list.

import { test, expect } from "./fixtures.js";

const FACEBOOK = { url: "https://www.facebook.com/", title: "Facebook" };

/** A running unlock of facebook.com with `msLeft` to go, out of 5 minutes. */
function unlockedFacebook(msLeft) {
  const now = Date.now();
  return {
    snoozed: { "facebook.com": { start: now - (300_000 - msLeft), expiry: now + msLeft, cap: 300_000 } },
  };
}

/** Visible text, so the site line isn't confused with the (hidden) list. */
const shown = (popup, text) => popup.getByText(text, { exact: true }).filter({ visible: true });

test("on a blocked site, the circle offers to unlock it", async ({ openPopup, readStorage }) => {
  const popup = await openPopup({ activeTab: FACEBOOK });

  await expect(shown(popup, "facebook.com")).toBeVisible();
  await expect(shown(popup, "Blocked")).toBeVisible();
  await expect(popup.getByRole("button", { name: "Unlock for 10 minutes" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "Unlock for 15 minutes" })).toBeVisible();

  await popup.getByRole("button", { name: "Unlock 5 min" }).click();

  await expect(shown(popup, "Unlocked")).toBeVisible();
  const { snoozed } = await readStorage("local", "snoozed");
  expect(snoozed["facebook.com"].cap).toBe(5 * 60_000);
});

test("during an unlock, the circle counts down with +1 min and Block now", async ({
  openPopup,
}) => {
  const popup = await openPopup({ activeTab: FACEBOOK, local: unlockedFacebook(96_000) });

  await expect(shown(popup, "Unlocked")).toBeVisible();
  // The circle only shows the time; ending the unlock is the Block now button.
  const circle = popup.getByRole("button", { name: /^1:3\d until blocked$/ });
  await expect(circle).toBeVisible();
  await expect(circle).toBeDisabled();
  await expect(popup.getByRole("button", { name: "+1 min" })).toBeEnabled();
  await expect(popup.getByRole("button", { name: "Block now" })).toBeEnabled();
});

test("in the unlock's last minute, the countdown turns red", async ({ openPopup }) => {
  const popup = await openPopup({ activeTab: FACEBOOK, local: unlockedFacebook(45_000) });
  await popup.emulateMedia({ colorScheme: "dark" });

  await expect(popup.getByText(/^0:4\d$/)).toHaveCSS("color", "rgb(248, 113, 113)");
  await expect(shown(popup, "Unlocked")).toHaveCSS("color", "rgb(248, 113, 113)");
});

test("before the last minute, the countdown stays amber", async ({ openPopup }) => {
  const popup = await openPopup({ activeTab: FACEBOOK, local: unlockedFacebook(96_000) });
  await popup.emulateMedia({ colorScheme: "dark" });

  await expect(popup.getByText(/^1:3\d$/)).toHaveCSS("color", "rgb(230, 233, 239)");
  await expect(shown(popup, "Unlocked")).toHaveCSS("color", "rgb(251, 191, 36)");
});

test("+1 min adds a minute to the unlock", async ({ openPopup, readStorage }) => {
  const popup = await openPopup({ activeTab: FACEBOOK, local: unlockedFacebook(96_000) });
  const { snoozed: before } = await readStorage("local", "snoozed");

  await popup.getByRole("button", { name: "+1 min" }).click();

  await expect
    .poll(async () => (await readStorage("local", "snoozed")).snoozed["facebook.com"].expiry)
    .toBe(before["facebook.com"].expiry + 60_000);
});

test("Block now ends the unlock", async ({ openPopup, readStorage }) => {
  const popup = await openPopup({ activeTab: FACEBOOK, local: unlockedFacebook(96_000) });

  await popup.getByRole("button", { name: "Block now" }).click();

  await expect(shown(popup, "Blocked")).toBeVisible();
  await expect(popup.getByRole("button", { name: "Unlock 5 min" })).toBeVisible();
  expect((await readStorage("local", "snoozed")).snoozed).toEqual({});
});

test("on a site that isn't blocked, the circle offers to block it", async ({
  openPopup,
  readStorage,
}) => {
  const popup = await openPopup({ activeTab: { url: "https://www.twitch.tv/", title: "Twitch" } });

  await expect(shown(popup, "twitch.tv")).toBeVisible();
  await expect(shown(popup, "Not blocked")).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Unlock for/ })).toHaveCount(0);

  await popup.getByRole("button", { name: "Block this site" }).click();

  await expect(popup.getByRole("button", { name: "Unlock 5 min" })).toBeVisible();
  const { blockedDomains } = await readStorage("sync", "blockedDomains");
  expect(blockedDomains).toContain("twitch.tv");
});

test("on a page that can't be blocked, the circle says there's nothing to block", async ({
  openPopup,
}) => {
  const popup = await openPopup({ activeTab: { url: "chrome://newtab/", title: "New Tab" } });

  await expect(shown(popup, "New Tab")).toBeVisible();
  await expect(popup.getByRole("button", { name: "Nothing to block here" })).toBeDisabled();
});

test("the Blocked sites row shows how many sites are blocked", async ({ openPopup }) => {
  const popup = await openPopup({ sync: { blockedDomains: ["a.com", "b.com"] } });

  await expect(popup.getByRole("button", { name: "Blocked sites 2" })).toBeVisible();
});

test("in the list, an unlocked site shows its time left", async ({ openPopup }) => {
  const popup = await openPopup({ local: unlockedFacebook(96_000) });

  await popup.getByRole("button", { name: /^Blocked sites/ }).click();

  await expect(
    popup.getByRole("listitem").filter({ hasText: "facebook.com" }),
  ).toContainText(/1:3\d left/);
  await expect(
    popup.getByRole("listitem").filter({ hasText: "instagram.com" }),
  ).not.toContainText("left");
});

test("removing an unlocked site also ends its unlock", async ({
  openPopup,
  background,
  readStorage,
}) => {
  const popup = await openPopup({ local: unlockedFacebook(96_000) });
  await background.evaluate(() =>
    chrome.alarms.create("snooze:facebook.com", { delayInMinutes: 2 }),
  );

  await popup.getByRole("button", { name: /^Blocked sites/ }).click();
  await popup.getByRole("button", { name: "Remove facebook.com" }).click();

  await expect(popup.getByRole("listitem").filter({ hasText: "facebook.com" })).toHaveCount(0);
  await expect.poll(async () => (await readStorage("local", "snoozed")).snoozed).toEqual({});
  expect(
    await background.evaluate(() => chrome.alarms.get("snooze:facebook.com")),
  ).toBeUndefined();
});

test("importing settings without an unlocked site ends its unlock", async ({
  openPopup,
  background,
  readStorage,
}) => {
  const popup = await openPopup({ local: unlockedFacebook(96_000) });
  await background.evaluate(() =>
    chrome.alarms.create("snooze:facebook.com", { delayInMinutes: 2 }),
  );
  await popup.getByRole("tab", { name: "Settings" }).click();

  const choosing = popup.waitForEvent("filechooser");
  await popup.getByRole("button", { name: "Import settings" }).click();
  await (await choosing).setFiles({
    name: "focus-guard-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ blockedDomains: ["tiktok.com"] })),
  });

  await expect.poll(async () => (await readStorage("local", "snoozed")).snoozed).toEqual({});
  await expect
    .poll(() => background.evaluate(() => chrome.alarms.get("snooze:facebook.com")))
    .toBeUndefined();
});
