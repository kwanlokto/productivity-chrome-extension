// Popup entry point: wire up tab navigation and initialize each view.
// (Loaded as an ES module — see popup.html.)

import { initHeaderView } from "./header-view.js";
import { initSitesView } from "./sites-view.js";
import { initYoutubeView } from "./youtube-view.js";
import { initSettingsView } from "./settings-view.js";

/**
 * Wire the top-level tab switcher with an accessible tablist: roving tabindex,
 * aria-selected, and arrow / Home / End keyboard navigation.
 * @returns {{ show: (name: string) => void }} switches to a tab by its data-tab name
 */
function initNav() {
  const tabs = [...document.querySelectorAll(".tab")];
  const panels = document.querySelectorAll(".panel");

  function activate(tab) {
    const target = tab.dataset.tab;
    tabs.forEach((t) => {
      const isActive = t === tab;
      t.classList.toggle("is-active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
      t.tabIndex = isActive ? 0 : -1; // roving tabindex
    });
    panels.forEach((p) =>
      p.classList.toggle("is-active", p.dataset.panel === target),
    );
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = tabs[(i + 1) % tabs.length];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next = tabs[(i - 1 + tabs.length) % tabs.length];
      } else if (e.key === "Home") {
        next = tabs[0];
      } else if (e.key === "End") {
        next = tabs[tabs.length - 1];
      }
      if (next) {
        e.preventDefault();
        activate(next);
        next.focus();
      }
    });
  });

  return {
    show(name) {
      const tab = tabs.find((t) => t.dataset.tab === name);
      if (tab) activate(tab);
    },
  };
}

const nav = initNav();
// While off, the break countdown lives on the Sites tab.
initHeaderView({ onSwitchedOff: () => nav.show("sites") });
initSitesView();
initYoutubeView();
initSettingsView();
