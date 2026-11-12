// Every label in the popup starts on one left edge (31px), and every trailing
// control (switches, steppers, arrows, ✕) ends on one right edge (309px). The
// centered Sites circle and the centered list titles are the deliberate exceptions.

import { test, expect } from "./fixtures.js";

const LEFT = 31;
const RIGHT = 309;

/**
 * Where the visible labels start and the visible trailing controls end, as two
 * sorted lists of distinct x positions.
 */
function edges(popup) {
  return popup.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && !el.closest(".hidden");
    const round = (x) => Math.round(x * 2) / 2;

    const lefts = new Set();
    const labels = document.querySelectorAll(
      ".section-title, .row, .nav-row, .item-list li",
    );
    for (const el of labels) {
      if (!visible(el)) continue;
      // The first piece of text in the element.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      const text = walker.nextNode();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      lefts.add(round(range.getBoundingClientRect().left));
    }
    // Where typed text (and the placeholder) starts in the Add fields.
    for (const input of document.querySelectorAll(".text-input")) {
      if (!visible(input)) continue;
      const style = getComputedStyle(input);
      lefts.add(round(input.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)));
    }

    const rights = new Set();
    const controls = document.querySelectorAll(
      ".row > .switch, .row > .stepper, .nav-row > svg, .remove-btn svg",
    );
    for (const el of controls) {
      if (visible(el)) rights.add(round(el.getBoundingClientRect().right));
    }
    return { lefts: [...lefts].sort((a, b) => a - b), rights: [...rights].sort((a, b) => a - b) };
  });
}

test("labels and controls line up on every tab and view", async ({ openPopup }) => {
  const popup = await openPopup();

  const views = [
    ["Sites", async () => {}],
    ["Sites → Blocked sites", () => popup.getByRole("button", { name: /^Blocked sites/ }).click()],
    ["YouTube", () => popup.getByRole("tab", { name: "YouTube" }).click()],
    ["YouTube → Allowed channels", () =>
      popup.getByRole("button", { name: /^Allowed channels/ }).click()],
    ["Settings", () => popup.getByRole("tab", { name: "Settings" }).click()],
  ];
  for (const [view, open] of views) {
    await open();
    await expect.poll(() => edges(popup), { message: view }).toEqual({
      lefts: [LEFT],
      rights: [RIGHT],
    });
  }
});

test("list screens center their title", async ({ openPopup }) => {
  const popup = await openPopup();
  await popup.getByRole("button", { name: /^Blocked sites/ }).click();

  const title = popup.getByRole("heading", { name: "Blocked sites" });
  // Polled: the view slides in, so the title only settles at the end.
  await expect
    .poll(async () => {
      const box = await title.boundingBox();
      return Math.round(box.x + box.width / 2);
    })
    .toBe(170);
});
