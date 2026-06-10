// Popup entry point: wire up tab navigation and initialize each view.
// (Loaded as an ES module — see popup.html.)

import { initSitesView } from "./sites-view.js";
import { initYoutubeView } from "./youtube-view.js";
import { initSettingsView } from "./settings-view.js";

/** Wire the top-level Blocked-sites / YouTube tab switcher. */
function initNav() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      panels.forEach((p) =>
        p.classList.toggle("is-active", p.dataset.panel === target),
      );
    });
  });
}

initNav();
initSitesView();
initYoutubeView();
initSettingsView();
