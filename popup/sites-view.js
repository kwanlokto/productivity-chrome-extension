// "Blocked sites" tab: the current-tab action circle and the blocked-domain list.

import { SNOOZE_MINUTES, RING_CIRCUMFERENCE } from "./config.js";
import { normalizeDomain, formatClock, reanimate } from "./util.js";
import { getDomains, getActiveSnooze, expiryOf } from "./storage.js";
import { getCurrentTabDomain, domainMatchesBlocked } from "./tabs.js";
import * as actions from "./actions.js";

// DOM refs (populated in initSitesView).
let listEl, emptyEl, formEl, inputEl;
let actionWrap, actionCircle, ringProgress, circleMain, circleSub;
let mainView, manageView, openManageBtn, backBtn;

// Handle for the live countdown interval, so we can cancel it on re-render.
let countdownTimer = null;

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
  actionCircle.classList.remove("is-block", "is-unblock", "is-countdown");
  actionCircle.classList.add(stateClass);
  circleMain.textContent = main;
  circleSub.textContent = sub;
  actionCircle.onclick = onClick;
}

/**
 * Drive the countdown ring + label for an active snooze, re-evaluating when it
 * expires.
 * @param {{ start?: number, expiry?: number } | number} snoozeEntry
 */
function startCountdown(snoozeEntry) {
  ringProgress.classList.remove("hidden");

  const expiry = expiryOf(snoozeEntry);
  const start =
    typeof snoozeEntry === "object" && snoozeEntry.start
      ? snoozeEntry.start
      : expiry - SNOOZE_MINUTES * 60 * 1000;
  const total = Math.max(1, expiry - start);

  const tick = () => {
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      updateStatusCircle(); // snooze ended — re-render as blocked
      return;
    }
    circleMain.textContent = formatClock(remaining);
    // Yellow ring = fraction of time remaining, so it shrinks as it counts down.
    const fraction = Math.max(0, Math.min(1, remaining / total));
    ringProgress.style.strokeDashoffset = String(
      RING_CIRCUMFERENCE * (1 - fraction),
    );
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

/**
 * Inspect the active tab and configure the circle for the right state:
 * not-blockable (hidden), not-blocked (Block), blocked (Unblock), or
 * snoozed (countdown / Re-block).
 */
async function updateStatusCircle() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  ringProgress.classList.add("hidden");

  const [tabDomain, domains, snoozed] = await Promise.all([
    getCurrentTabDomain(),
    getDomains(),
    getActiveSnooze(),
  ]);

  const blockable = tabDomain && tabDomain.includes(".");
  const matched = blockable ? domainMatchesBlocked(tabDomain, domains) : null;

  if (!blockable) {
    // chrome://, new tab, etc. — nothing to act on.
    actionWrap.classList.add("hidden");
    return;
  }

  if (!matched) {
    showCircle("is-block", "Block", "this site", () =>
      run(() => actions.blockCurrentSite(tabDomain)),
    );
    return;
  }

  const snoozeEntry = snoozed[matched];
  if (snoozeEntry) {
    showCircle("is-countdown", "", "left", () =>
      run(() => actions.unsnooze(matched)),
    );
    startCountdown(snoozeEntry);
  } else {
    showCircle("is-unblock", "Unblock", `${SNOOZE_MINUTES} min`, () =>
      run(() => actions.snooze(matched, SNOOZE_MINUTES)),
    );
  }
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

  mainView = document.getElementById("sites-main");
  manageView = document.getElementById("sites-manage");
  openManageBtn = document.getElementById("open-manage");
  backBtn = document.getElementById("back-to-main");

  bindManageNav();
  bindAddForm();
  refresh();
}
