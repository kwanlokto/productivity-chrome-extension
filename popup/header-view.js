// Header: the on/off switch for the whole extension. It spans every tab, so it
// lives here rather than in any one tab's view. While Focus Guard is off, the
// Sites tab shows the break countdown (sites-view.js) and the tabs are locked.

import * as actions from "./actions.js";
import { getPauseMinutes, getPausedUntil } from "./storage.js";

// DOM refs (populated in initHeaderView).
let powerSwitch, tabsEl;

/** Called whenever the header renders as off. */
let onSwitchedOff = () => {};

// One-shot timer that re-renders the moment a pause runs out, without waiting
// on the background's resume alarm.
let resumeTimer = null;

/** Re-read state and paint the switch and the tab lock. */
async function render() {
  const [minutes, pausedUntil] = await Promise.all([
    getPauseMinutes(),
    getPausedUntil(),
  ]);
  // Clear after the await so overlapping renders can't orphan a timer.
  clearTimeout(resumeTimer);
  resumeTimer = null;

  const on = !pausedUntil;
  powerSwitch.checked = on;
  const label = on
    ? `Turn Focus Guard off for ${minutes} min`
    : "Turn Focus Guard back on";
  powerSwitch.title = label;
  powerSwitch.setAttribute("aria-label", label);

  // `inert` also blocks clicks, keyboard focus, and assistive tech.
  tabsEl.inert = !on;
  tabsEl.classList.toggle("is-disabled", !on);

  if (!on) {
    onSwitchedOff();
    resumeTimer = setTimeout(render, pausedUntil - Date.now());
  }
}

/**
 * Run an async action, then re-render. The switch is held disabled until it
 * finishes, so a fast off-on double flip can't interleave pause and resume
 * (and leave no blocking rules while showing "on"). Errors are surfaced to the
 * console rather than left as unhandled rejections.
 * @param {() => Promise<void>} action
 */
function run(action) {
  powerSwitch.disabled = true;
  action()
    .then(render)
    .catch((e) => console.error("[Focus Guard] action failed:", e))
    .finally(() => {
      powerSwitch.disabled = false;
    });
}

/**
 * Keep the header in sync when state changes from elsewhere: the background's
 * resume alarm ending the pause, the Sites tab's "Turn on now", or the Settings
 * tab changing the break length.
 */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pausedUntil) render();
    if (area === "sync" && changes.pauseMinutes) render();
  });
}

/**
 * Initialize the header.
 * @param {{ onSwitchedOff?: () => void }} [options]
 */
export function initHeaderView(options = {}) {
  powerSwitch = document.getElementById("power-switch");
  tabsEl = document.getElementById("tabs");
  if (options.onSwitchedOff) onSwitchedOff = options.onSwitchedOff;

  powerSwitch.addEventListener("change", () => {
    if (powerSwitch.checked) {
      run(() => actions.resumeExtension());
    } else {
      run(async () => actions.pauseExtension(await getPauseMinutes()));
    }
  });
  bindStorageSync();
  render();
}
