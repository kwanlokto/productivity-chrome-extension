// "Sites" tab: the current tab's circle and the blocked-domain list.

import * as actions from "./actions.js";

import { DEFAULT_UNLOCK_MINUTES, RING_CIRCUMFERENCE } from "./config.js";
import { domainMatchesBlocked, getCurrentTab } from "./tabs.js";
import {
  capOf,
  expiryOf,
  getActiveSnooze,
  getDomains,
  getPauseMinutes,
  getPausedUntil,
  getUnlockMinutes,
} from "./storage.js";
import { formatClock, normalizeDomain, reanimate } from "./util.js";

const REMOVE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// DOM refs (populated in initSitesView).
let listEl, emptyEl, formEl, inputEl, countEl;
let siteIcon, pageIcon, siteName, siteStatus;
let circle, ringProgress, circleMain, circleSub, pillRow;
let addMinuteBtn, blockNowBtn, turnOnBtn;
let mainView, manageView, openManageBtn, backBtn;

// The "unlock for N×" buttons under the circle, as [{ btn, sub, factor }].
let multiplierBtns = [];

// Ticks the circle's clock (an unlock's time left, or the break's).
let circleTimer = null;

// Ticks the "m:ss left" chips of unlocked sites in the list.
let listTimer = null;

/* ------------------------------ Domain list ------------------------------- */

/**
 * Render the blocked-domain list. An unlocked domain shows its time left.
 * @param {string[]} domains
 * @param {Record<string, unknown>} snoozed active snooze map
 */
function renderDomains(domains, snoozed) {
  clearInterval(listTimer);
  listTimer = null;
  listEl.replaceChildren();
  listEl.classList.toggle("hidden", domains.length === 0);
  emptyEl.classList.toggle("hidden", domains.length > 0);
  countEl.textContent = String(domains.length);

  const chips = [];
  for (const domain of domains) {
    const li = document.createElement("li");

    const icon = document.createElement("span");
    icon.className = "site-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = domain[0];

    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = domain;
    li.append(icon, name);

    if (snoozed[domain]) {
      const chip = document.createElement("span");
      chip.className = "chip is-warn";
      chips.push({ chip, expiry: expiryOf(snoozed[domain]) });
      li.append(chip);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.title = "Remove";
    removeBtn.setAttribute("aria-label", `Remove ${domain}`);
    removeBtn.innerHTML = REMOVE_ICON;
    removeBtn.addEventListener("click", () =>
      run(() => actions.removeDomain(domain)),
    );
    li.append(removeBtn);

    listEl.appendChild(li);
  }

  if (chips.length === 0) return;
  const tick = () => {
    const now = Date.now();
    for (const { chip, expiry } of chips) {
      if (expiry <= now) {
        clearInterval(listTimer);
        listTimer = null;
        refresh(); // an unlock ended
        return;
      }
      chip.textContent = `${formatClock(expiry - now)} left`;
    }
  };
  listTimer = setInterval(tick, 500);
  tick();
}

/* ---------------------------- The current site ---------------------------- */

/**
 * Fill the line above the circle.
 * @param {string} name a domain, a page title, or a sentence
 * @param {{ letter?: string, page?: boolean, status?: string,
 *   tone?: "danger" | "warn" | "neutral" }} [options]
 *   `letter` labels the site's icon (none when ""); `page` shows a plain page
 *   icon instead; `status` and `tone` fill the coloured chip.
 */
function showSite(name, { letter = name[0], page = false, status = "", tone } = {}) {
  siteIcon.textContent = letter || "";
  siteIcon.classList.toggle("hidden", page || !letter);
  pageIcon.classList.toggle("hidden", !page);
  siteName.textContent = name;
  siteStatus.textContent = status;
  siteStatus.className = tone ? `chip is-${tone}` : "chip";
  siteStatus.classList.toggle("hidden", !status);
}

/* ------------------------------- The circle ------------------------------- */

/**
 * Point the circle at a state and hide every button under it; the caller shows
 * the ones that state needs with showPill.
 * @param {"block" | "unblock" | "countdown" | "none" | "off"} state
 * @param {string} main big label (or "" while a clock drives it)
 * @param {string} sub small label under it
 * @param {(() => void) | null} onClick null makes the circle display-only
 */
function showCircle(state, main, sub, onClick) {
  circle.className = `circle is-${state}`;
  circleMain.textContent = main;
  circleSub.textContent = sub;
  circle.onclick = onClick;
  circle.disabled = onClick == null;
  ringProgress.classList.add("hidden");

  for (const pill of pillRow.querySelectorAll(".pill")) {
    pill.classList.add("hidden");
    pill.onclick = null;
    pill.disabled = false;
  }
  pillRow.classList.add("hidden");
}

/**
 * Show one of the buttons under the circle.
 * @param {HTMLButtonElement} btn
 * @param {() => void} onClick
 */
function showPill(btn, onClick) {
  btn.onclick = onClick;
  btn.classList.remove("hidden");
  pillRow.classList.remove("hidden");
}

/**
 * Draw the progress arc at a fraction (0–1) of the full ring.
 * @param {number} fraction
 */
function setRing(fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  ringProgress.classList.remove("hidden");
  ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - f));
}

/**
 * Tick `onTick(msLeft)` until `until`, then re-render the whole tab.
 * @param {number} until timestamp the clock runs out
 * @param {(remaining: number) => void} onTick
 */
function startClock(until, onTick) {
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      stopClock();
      refresh();
      return;
    }
    onTick(remaining);
  };
  // Start the interval before the first tick so an elapsed clock can clear it.
  circleTimer = setInterval(tick, 250);
  tick();
}

function stopClock() {
  clearInterval(circleTimer);
  circleTimer = null;
}

/**
 * Inspect the active tab and configure the circle: off (the break countdown),
 * unlocked (its countdown), can't be blocked, not blocked (Block), or blocked
 * (Unlock).
 */
async function updateStatusCircle() {
  const [tab, domains, snoozed, unlockMinutes, pausedUntil, pauseMinutes] =
    await Promise.all([
      getCurrentTab(),
      getDomains(),
      getActiveSnooze(),
      getUnlockMinutes(),
      getPausedUntil(),
      getPauseMinutes(),
    ]);
  // Stop after the await so overlapping re-renders can't orphan a timer.
  stopClock();

  if (pausedUntil) {
    showSite("Focus Guard is off · nothing is blocked", { letter: "" });
    showCircle("off", "", "until back on", null);
    showPill(turnOnBtn, () => run(() => actions.resumeExtension()));
    // The break's full length isn't stored, so the arc is measured against the
    // current Break length setting.
    const total = pauseMinutes * 60_000;
    startClock(pausedUntil, (remaining) => {
      circleMain.textContent = formatClock(remaining);
      setRing(remaining / total);
    });
    return;
  }

  const domain = tab.domain;
  const blockable = domain.includes(".");
  const matched = blockable ? domainMatchesBlocked(domain, domains) : null;

  if (matched && snoozed[matched]) {
    const entry = snoozed[matched];
    // The ring shows time left out of the unlock's original length (its cap),
    // so it matches the clock even after "+1 min" (which keeps the cap).
    const cap = Math.max(1, capOf(entry));
    showSite(domain, { status: "Unlocked", tone: "warn" });
    showCircle("countdown", "", "left", null);
    showPill(addMinuteBtn, () => run(() => actions.extendSnooze(matched, 1)));
    showPill(blockNowBtn, () => run(() => actions.unsnooze(matched)));
    startClock(expiryOf(entry), (remaining) => {
      circleMain.textContent = formatClock(remaining);
      setRing(remaining / cap);
      // "+1 min" can't top the unlock up past its original length.
      addMinuteBtn.disabled = remaining >= cap - 1500;
    });
    return;
  }

  if (!blockable) {
    // chrome://, a new tab, the Web Store, etc.
    showSite(tab.title || "This page", { page: true });
    showCircle("none", "Nothing", "to block here", null);
    return;
  }

  if (!matched) {
    showSite(domain, { status: "Not blocked", tone: "neutral" });
    showCircle("block", "Block", "this site", () =>
      run(() => actions.blockCurrentSite(domain)),
    );
    return;
  }

  const minutes = unlockMinutes || DEFAULT_UNLOCK_MINUTES;
  showSite(domain, { status: "Blocked", tone: "danger" });
  showCircle("unblock", "Unlock", `${minutes} min`, () =>
    run(() => actions.snooze(matched, minutes)),
  );
  for (const { btn, sub, factor } of multiplierBtns) {
    const total = minutes * factor;
    sub.textContent = `${total} min`;
    btn.title = `Unlock for ${total} min (${factor}×)`;
    btn.setAttribute("aria-label", `Unlock for ${total} minutes`);
    showPill(btn, () => run(() => actions.snooze(matched, total)));
  }
}

/* -------------------------------- Plumbing -------------------------------- */

/** Re-read state and repaint the whole tab. */
async function refresh() {
  const [domains, snoozed, pausedUntil] = await Promise.all([
    getDomains(),
    getActiveSnooze(),
    getPausedUntil(),
  ]);
  renderDomains(domains, snoozed);
  // While off, the list can't be opened; close it if it was open.
  openManageBtn.disabled = Boolean(pausedUntil);
  if (pausedUntil && !manageView.classList.contains("hidden")) {
    setManageView(false, { animate: false });
  }
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
 * Switch between the main (circle) view and the list view, sliding the incoming
 * view in (from the right going forward, from the left going back).
 * @param {boolean} showManage
 * @param {{ animate?: boolean }} [options]
 */
function setManageView(showManage, { animate = true } = {}) {
  const [from, to] = showManage ? [mainView, manageView] : [manageView, mainView];
  from.classList.add("hidden");
  to.classList.remove("hidden");
  if (animate) reanimate(to, showManage ? "slide-in-right" : "slide-in-left");
}

/** Wire the "Blocked sites" row and the list's Back button. */
function bindManageNav() {
  openManageBtn.addEventListener("click", () => setManageView(true));
  backBtn.addEventListener("click", () => setManageView(false));
}

/**
 * Keep this tab in sync when state changes elsewhere: the Settings tab editing a
 * duration, a reset/import rewriting the block list (the background then ends
 * unlocks of removed sites), the header switch, or the background's alarms.
 */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "sync" &&
      (changes.unlockMinutes || changes.blockedDomains || changes.pauseMinutes)
    ) {
      refresh();
    }
    if (area === "local" && (changes.pausedUntil || changes.snoozed)) {
      refresh();
    }
  });
}

/** Wire up the add-domain form. */
function bindAddForm() {
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const domain = normalizeDomain(inputEl.value);
    if (!domain || !domain.includes(".")) {
      inputEl.value = "";
      inputEl.placeholder = "Enter a valid domain";
      return;
    }
    inputEl.value = "";
    run(() => actions.addDomain(domain));
  });
}

/** Initialize the Sites tab. */
export function initSitesView() {
  listEl = document.getElementById("domain-list");
  emptyEl = document.getElementById("empty");
  formEl = document.getElementById("add-form");
  inputEl = document.getElementById("domain-input");
  countEl = document.getElementById("blocked-count");

  siteIcon = document.getElementById("site-icon");
  pageIcon = document.getElementById("page-icon");
  siteName = document.getElementById("site-name");
  siteStatus = document.getElementById("site-status");

  circle = document.getElementById("action-circle");
  ringProgress = document.querySelector(".ring-progress");
  circleMain = document.getElementById("circle-main");
  circleSub = document.getElementById("circle-sub");
  pillRow = document.getElementById("pill-row");
  multiplierBtns = [
    { btn: document.getElementById("action-circle-2x"), sub: document.getElementById("circle-2x-sub"), factor: 2 },
    { btn: document.getElementById("action-circle-3x"), sub: document.getElementById("circle-3x-sub"), factor: 3 },
  ];
  addMinuteBtn = document.getElementById("add-minute-btn");
  blockNowBtn = document.getElementById("block-now-btn");
  turnOnBtn = document.getElementById("turn-on-btn");

  mainView = document.getElementById("sites-main");
  manageView = document.getElementById("sites-manage");
  openManageBtn = document.getElementById("open-manage");
  backBtn = document.getElementById("back-to-main");

  bindManageNav();
  bindAddForm();
  bindStorageSync();
  refresh();
}
