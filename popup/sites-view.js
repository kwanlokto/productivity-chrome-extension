// "Blocked sites" tab: the current-tab action circle and the blocked-domain list.

import * as actions from "./actions.js";

import {
  DEFAULT_UNLOCK_MINUTES,
  DEFAULT_PAUSE_MINUTES,
  MIN_UNLOCK_MINUTES,
  MAX_UNLOCK_MINUTES,
  RING_CIRCUMFERENCE,
} from "./config.js";
import { domainMatchesBlocked, getCurrentTabDomain } from "./tabs.js";
import {
  capOf,
  expiryOf,
  getActiveSnooze,
  getDomains,
  getPausedUntil,
  getUnlockMinutes,
} from "./storage.js";
import { clampMinutes, formatClock, normalizeDomain, reanimate } from "./util.js";

// DOM refs (populated in initSitesView).
let listEl, emptyEl, formEl, inputEl;
let actionWrap, actionCircle, ringProgress, circleMain, circleSub;
let mainView, manageView, openManageBtn, backBtn, addMinuteBtn;
let pauseControls, pauseInput, pauseBtn, resumeBtn;

// Secondary "unlock for N×" buttons that flank the main circle, populated in
// initSitesView as [{ btn, sub, factor }].
let multiplierBtns = [];

// Handle for the live countdown interval, so we can cancel it on re-render.
let countdownTimer = null;

// The user's configured "Unlock" duration, refreshed on each status update.
let unlockMinutes = DEFAULT_UNLOCK_MINUTES;

/* ------------------------------ Domain list ------------------------------- */

/**
 * Render the blocked-domain list. Snoozed domains are dimmed.
 * @param {string[]} domains
 * @param {Record<string, unknown>} snoozed active snooze map
 */
function renderDomains(domains, snoozed) {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", domains.length > 0);

  for (const domain of domains) {
    const li = document.createElement("li");
    if (snoozed[domain]) li.classList.add("is-snoozed");

    const span = document.createElement("span");
    span.className = "domain-text";
    span.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.title = "Remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () =>
      run(() => actions.removeDomain(domain)),
    );

    li.append(span, removeBtn);
    listEl.appendChild(li);
  }
}

/* --------------------------- Status action circle ------------------------- */

/**
 * Point the big circle at a state: set its colour class, label, and click action.
 * @param {"is-block"|"is-unblock"|"is-countdown"} stateClass
 * @param {string} main big label (or "" while a countdown drives it)
 * @param {string} sub small sub-label
 * @param {() => void} onClick
 */
function showCircle(stateClass, main, sub, onClick) {
  actionWrap.classList.remove("hidden");
  actionCircle.classList.remove("is-block", "is-unblock", "is-countdown", "is-disabled");
  actionCircle.classList.add(stateClass);
  circleMain.textContent = main;
  circleSub.textContent = sub;
  actionCircle.onclick = onClick;
  actionCircle.disabled = onClick == null; // inert when there's no action
  hideMultiplierBtns(); // only the unblock state re-shows them (updateStatusCircle)
  // Only the countdown state re-shows "+1 minute".
  addMinuteBtn.classList.add("hidden");
  addMinuteBtn.onclick = null;
}

/** Hide the secondary multiplier-unlock buttons. */
function hideMultiplierBtns() {
  for (const { btn } of multiplierBtns) {
    btn.classList.add("hidden");
    btn.onclick = null;
  }
}

/**
 * Show the multiplier buttons, each unlocking `domain` for (base × its factor).
 * @param {string} domain
 * @param {number} minutes the base (single) unlock duration
 */
function showMultiplierBtns(domain, minutes) {
  for (const { btn, sub, factor } of multiplierBtns) {
    const total = minutes * factor;
    sub.textContent = `${total} min`;
    btn.title = `Unlock for ${total} min (${factor}×)`;
    btn.onclick = () => run(() => actions.snooze(domain, total));
    btn.classList.remove("hidden");
  }
}

/**
 * Drive the countdown ring + label for an active snooze, re-evaluating when it
 * expires.
 * @param {{ start?: number, expiry?: number } | number} snoozeEntry
 */
function startCountdown(snoozeEntry) {
  ringProgress.classList.remove("hidden");

  const expiry = expiryOf(snoozeEntry);
  // The ring represents time remaining out of the snooze's original granted
  // duration (the cap), so it always matches the clock — including after
  // "+1 minute" pushes the expiry out (which leaves the cap unchanged).
  const cap = Math.max(1, capOf(snoozeEntry));

  const tick = () => {
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      updateStatusCircle(); // snooze ended — re-render as blocked
      return;
    }
    circleMain.textContent = formatClock(remaining);
    // Yellow ring = fraction of the original duration remaining; shrinks to empty.
    const fraction = Math.max(0, Math.min(1, remaining / cap));
    ringProgress.style.strokeDashoffset = String(
      RING_CIRCUMFERENCE * (1 - fraction),
    );
    // Disable "+1" once we're already at the cap (can't add any more).
    if (!addMinuteBtn.classList.contains("hidden")) {
      addMinuteBtn.disabled = remaining >= cap - 1500;
    }
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

/**
 * Drive the inert circle's "m:ss" label while the whole extension is paused,
 * re-rendering normally once the pause elapses. Reuses countdownTimer (paused and
 * snoozed states are mutually exclusive).
 * @param {number} until pause-end timestamp
 */
function startPauseCountdown(until) {
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      updateStatusCircle(); // pause ended — re-render
      return;
    }
    circleMain.textContent = formatClock(remaining);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

/**
 * Toggle the disable section between its two states: the duration controls
 * (enabled) and the "Turn Focus Guard back on" button (disabled).
 * @param {boolean} paused
 */
function renderPauseBar(paused) {
  pauseControls.classList.toggle("hidden", paused);
  resumeBtn.classList.toggle("hidden", !paused);
  if (!paused && document.activeElement !== pauseInput) {
    pauseInput.value = String(DEFAULT_PAUSE_MINUTES);
  }
}

/**
 * Which snooze the circle counts down: only the current tab's own snooze. (The
 * background only auto-opens the popup while you're on the expiring site, so the
 * popup always reflects the tab you're looking at — no cross-tab countdowns.)
 * @param {string | null} matched the current tab's blocked-list match
 * @param {Record<string, unknown>} snoozed active snooze map
 * @returns {string | null} the domain to count down, or null
 */
function pickCountdownDomain(matched, snoozed) {
  return matched && snoozed[matched] ? matched : null;
}

/**
 * Inspect the active tab and configure the circle for the right state:
 * snoozed (countdown / Re-block), not-blockable (inert), not-blocked (Block), or
 * blocked (Unlock).
 */
async function updateStatusCircle() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  ringProgress.classList.add("hidden");

  const [tabDomain, domains, snoozed, minutes, pausedUntil] = await Promise.all([
    getCurrentTabDomain(),
    getDomains(),
    getActiveSnooze(),
    getUnlockMinutes(),
    getPausedUntil(),
  ]);
  unlockMinutes = minutes;

  // Whole extension disabled — nothing is blocked. The circle becomes an inert
  // live countdown; the section below swaps to "Turn Focus Guard back on".
  if (pausedUntil) {
    renderPauseBar(true);
    showCircle("is-disabled", "", "off", null);
    startPauseCountdown(pausedUntil);
    return;
  }
  renderPauseBar(false);

  const blockable = tabDomain && tabDomain.includes(".");
  const matched = blockable ? domainMatchesBlocked(tabDomain, domains) : null;

  const countdownDomain = pickCountdownDomain(matched, snoozed);
  if (countdownDomain) {
    showCircle("is-countdown", "", "left", () =>
      run(() => actions.unsnooze(countdownDomain)),
    );
    // Top up the running unlock by a minute (capped at its original duration).
    addMinuteBtn.classList.remove("hidden");
    addMinuteBtn.disabled = false;
    addMinuteBtn.onclick = () => run(() => actions.extendSnooze(countdownDomain, 1));
    startCountdown(snoozed[countdownDomain]); // first tick sets the disabled state
    return;
  }

  if (!blockable) {
    // chrome://, new tab, etc. — show the circle but inert (nothing to act on).
    showCircle("is-disabled", "—", "can’t block", null);
    return;
  }

  if (!matched) {
    showCircle("is-block", "Block", "this site", () =>
      run(() => actions.blockCurrentSite(tabDomain)),
    );
    return;
  }

  showCircle("is-unblock", "Unlock", `${unlockMinutes} min`, () =>
    run(() => actions.snooze(matched, unlockMinutes)),
  );
  showMultiplierBtns(matched, unlockMinutes);
}

/* -------------------------------- Plumbing -------------------------------- */

/** Re-read state and repaint the whole sites tab. */
async function refresh() {
  const [domains, snoozed] = await Promise.all([getDomains(), getActiveSnooze()]);
  renderDomains(domains, snoozed);
  await updateStatusCircle();
}

/**
 * Run an async action, then refresh the UI. Errors are surfaced to the console
 * rather than left as unhandled rejections.
 * @param {() => Promise<void>} action
 */
function run(action) {
  action()
    .then(refresh)
    .catch((e) => console.error("[Focus Guard] action failed:", e));
}

/**
 * Switch between the main (circle) view and the manage-list view, sliding the
 * incoming view in (from the right going forward, from the left going back).
 * @param {boolean} showManage
 */
function setManageView(showManage) {
  if (showManage) {
    mainView.classList.add("hidden");
    manageView.classList.remove("hidden");
    reanimate(manageView, "slide-in-right");
  } else {
    manageView.classList.add("hidden");
    mainView.classList.remove("hidden");
    reanimate(mainView, "slide-in-left");
  }
}

/** Wire the "Change blocked sites" / back navigation. */
function bindManageNav() {
  openManageBtn.addEventListener("click", () => setManageView(true));
  backBtn.addEventListener("click", () => setManageView(false));
}

/**
 * Keep this tab in sync when settings change from elsewhere — the Settings tab
 * editing the unlock duration, or a reset/import rewriting the block list.
 */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.unlockMinutes || changes.blockedDomains)) {
      refresh();
    }
    // Pausing/resuming the whole extension flips the circle to/from "Paused".
    if (area === "local" && changes.pausedUntil) {
      refresh();
    }
  });
}

/** Wire the global pause / resume controls on the Main tab. */
function bindPause() {
  pauseBtn.addEventListener("click", () => {
    const minutes = clampMinutes(pauseInput.value, MIN_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES);
    if (minutes == null) {
      pauseInput.value = String(DEFAULT_PAUSE_MINUTES);
      return;
    }
    run(() => actions.pauseExtension(minutes));
  });
  resumeBtn.addEventListener("click", () => run(() => actions.resumeExtension()));
}

/** Wire up the add-domain form. */
function bindAddForm() {
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const domain = normalizeDomain(inputEl.value);
    if (!domain || !domain.includes(".")) {
      inputEl.value = "";
      inputEl.placeholder = "enter a valid domain";
      return;
    }
    inputEl.value = "";
    run(() => actions.addDomain(domain));
  });
}

/** Initialize the Blocked-sites tab. */
export function initSitesView() {
  listEl = document.getElementById("domain-list");
  emptyEl = document.getElementById("empty");
  formEl = document.getElementById("add-form");
  inputEl = document.getElementById("domain-input");

  actionWrap = document.getElementById("action-circle-wrap");
  actionCircle = document.getElementById("action-circle");
  ringProgress = document.querySelector(".ring-progress");
  circleMain = document.getElementById("circle-main");
  circleSub = document.getElementById("circle-sub");
  multiplierBtns = [
    { btn: document.getElementById("action-circle-2x"), sub: document.getElementById("circle-2x-sub"), factor: 2 },
    { btn: document.getElementById("action-circle-3x"), sub: document.getElementById("circle-3x-sub"), factor: 3 },
  ];

  mainView = document.getElementById("sites-main");
  manageView = document.getElementById("sites-manage");
  openManageBtn = document.getElementById("open-manage");
  backBtn = document.getElementById("back-to-main");
  addMinuteBtn = document.getElementById("add-minute-btn");

  pauseControls = document.getElementById("pause-controls");
  pauseInput = document.getElementById("pause-input");
  pauseBtn = document.getElementById("pause-btn");
  resumeBtn = document.getElementById("resume-btn");

  bindManageNav();
  bindAddForm();
  bindPause();
  bindStorageSync();
  refresh();
}
