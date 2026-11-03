// Header: the on/off switch for the whole extension. It spans every tab, so it
// lives here rather than in any one tab's view.

import * as actions from "./actions.js";
import { getPauseMinutes, getPausedUntil } from "./storage.js";
import { formatClock } from "./util.js";

// DOM refs (populated in initHeaderView).
let powerSwitch, countdownEl, appBody;

// Handle for the live "m:ss left" interval, so we can cancel it on re-render.
let countdownTimer = null;

/**
 * Tick the "m:ss left" label until the pause ends, then re-render as on.
 * @param {number} until pause-end timestamp
 */
function startCountdown(until) {
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      render(); // pause ended — back on
      return;
    }
    countdownEl.textContent = `${formatClock(remaining)} left`;
  };
  // Start the interval before the first tick so an already-elapsed pause can
  // clear it.
  countdownTimer = setInterval(tick, 250);
  tick();
}

/** Re-read state and paint the switch and countdown. */
async function render() {
  const [minutes, pausedUntil] = await Promise.all([
    getPauseMinutes(),
    getPausedUntil(),
  ]);
  // Clear after the await so overlapping renders can't orphan an interval.
  clearInterval(countdownTimer);
  countdownTimer = null;

  const on = !pausedUntil;
  powerSwitch.checked = on;
  const label = on
    ? `Turn Focus Guard off for ${minutes} min`
    : "Turn Focus Guard back on";
  powerSwitch.title = label;
  powerSwitch.setAttribute("aria-label", label);

  // Dim everything below the header while off. `inert` also blocks clicks,
  // keyboard focus, and assistive tech, so nothing there looks usable.
  appBody.classList.toggle("is-disabled", !on);
  appBody.inert = !on;

  countdownEl.classList.toggle("hidden", on);
  if (!on) startCountdown(pausedUntil);
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
 * resume alarm ending the pause, or the Settings tab changing its duration.
 */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pausedUntil) render();
    if (area === "sync" && changes.pauseMinutes) render();
  });
}

/** Initialize the header. */
export function initHeaderView() {
  powerSwitch = document.getElementById("power-switch");
  countdownEl = document.getElementById("power-countdown");
  appBody = document.getElementById("app-body");

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
