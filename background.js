// Focus Guard — background service worker (ES module; see manifest "type").
// Keeps declarativeNetRequest dynamic rules in sync with the user's blocked-domain list.
// Also handles snooze: temporarily removes a domain's rule for X minutes, then restores it.

import {
  DEFAULT_BLOCKED,
  DEFAULT_YOUTUBE,
  DEFAULT_CHANNELS,
  blockRegexFor,
  blockSubstitutionFor,
} from "./shared/core.js";

// --- Snooze helpers ---
// Snoozed domains live in local storage as { domain -> { start, expiry } }.
// (Older entries may be a bare expiry timestamp — tolerate both.)

/**
 * Read the expiry timestamp out of a snooze entry (object or legacy number).
 * @param {number | { expiry: number }} entry
 * @returns {number}
 */
function expiryOf(entry) {
  return typeof entry === "number" ? entry : entry.expiry;
}

/**
 * Active snooze map with expired entries purged.
 * @returns {Promise<Record<string, unknown>>}
 */
async function getSnoozed() {
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  // Purge any already-expired entries.
  const now = Date.now();
  const active = Object.fromEntries(
    Object.entries(snoozed).filter(([, v]) => expiryOf(v) > now)
  );
  return active;
}

/**
 * Persist the snooze map.
 * @param {Record<string, unknown>} snoozed
 */
async function setSnoozed(snoozed) {
  await chrome.storage.local.set({ snoozed });
}

// --- Rule building ---
// Rules use regexFilter (not urlFilter) so we can capture the WHOLE original URL
// (\0) and pass it to the blocked page. That lets "unblock" return you to the
// exact page rather than just the domain root. The regex/substitution helpers
// live in shared/core.js, shared with popup/rules.js.

/**
 * Build one redirect-to-blocked-page rule per blocked, non-snoozed domain.
 * @param {string[]} domains
 * @param {Record<string, unknown>} snoozed
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
function buildRules(domains, snoozed) {
  return domains
    .filter((d) => !snoozed[d]) // skip currently snoozed domains
    .map((domain, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: blockSubstitutionFor(domain) }
      },
      condition: {
        regexFilter: blockRegexFor(domain),
        resourceTypes: ["main_frame"]
      }
    }));
}

/** Replace all dynamic rules with a fresh set built from current state. */
async function doSyncRules() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const snoozed = await getSnoozed();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(blockedDomains, snoozed);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// Serialize sync calls so concurrent triggers can't race into a duplicate-id error.
let syncChain = Promise.resolve();

/** Queue a rule re-sync behind any in-flight one. */
function syncRules() {
  syncChain = syncChain.then(doSyncRules, doSyncRules);
  return syncChain;
}

/**
 * Reload any open tabs on a domain so the (just-restored) blocking rule catches
 * them — otherwise a tab already sitting on the live site stays unblocked until
 * the user navigates.
 * @param {string} domain
 */
async function reblockOpenTabs(domain) {
  const tabs = await chrome.tabs.query({
    url: [`*://${domain}/*`, `*://*.${domain}/*`],
  });
  for (const tab of tabs) {
    if (tab.id != null) chrome.tabs.reload(tab.id);
  }
}

// --- Auto-open countdown ---
// We don't touch the toolbar icon. Instead the popup (which shows the in-popup
// countdown circle) is opened 30s before the nearest snooze expires. Chrome can't
// pin a popup open, so to keep it up through that final window we REOPEN it
// whenever it closes (navigating/clicking the page closes it) and whenever a
// browser window regains focus.

const OPEN_AT_30_MS = 30_000;
const OPEN30_ALARM = "open-30";

// Whether the popup is currently open, tracked via a runtime port it connects on
// load (see popup/popup.js).
let popupOpen = false;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupOpen = true;
  port.onDisconnect.addListener(() => {
    popupOpen = false;
    // Keep it up during the final window: reopen shortly after it closes.
    setTimeout(reopenIfInWindow, 200);
  });
});

// When a browser window regains focus during the final window (user came back
// from another app/window, or the first open failed), bring the popup back.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  reopenIfInWindow();
});

/** Soonest expiry among active snoozes, or null if none. */
async function getNearestExpiry() {
  const snoozed = await getSnoozed();
  const expiries = Object.values(snoozed).map(expiryOf);
  return expiries.length ? Math.min(...expiries) : null;
}

/** Are we inside the final-30s window of an active snooze? */
async function withinFinalWindow() {
  const expiry = await getNearestExpiry();
  if (!expiry) return false;
  const remaining = expiry - Date.now();
  return remaining > 0 && remaining <= OPEN_AT_30_MS;
}

/** Open the extension's own popup, ignoring "no active window"/unsupported errors. */
function openPopupSafely() {
  try {
    const p = chrome.action.openPopup?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* no focused window or unsupported — nothing else to do */
  }
}

/** Reopen the popup if it's closed and we're still in the final window. */
async function reopenIfInWindow() {
  if (popupOpen) return;
  if (await withinFinalWindow()) openPopupSafely();
}

/**
 * (Re)schedule the alarm that opens the popup 30s before the nearest snooze
 * expires. Alarms persist across worker restarts, so it fires even if the service
 * worker was asleep. If we're already inside the window, open right away.
 */
async function scheduleCountdown() {
  await chrome.alarms.clear(OPEN30_ALARM);
  const expiry = await getNearestExpiry();
  if (!expiry) return;
  const when = expiry - OPEN_AT_30_MS;
  if (when > Date.now()) {
    await chrome.alarms.create(OPEN30_ALARM, { when });
  } else if (expiry > Date.now()) {
    openPopupSafely(); // already inside the window
  }
}

// --- Alarms ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === OPEN30_ALARM) {
    openPopupSafely(); // show the countdown as the final 30s begin
    return;
  }
  if (!alarm.name.startsWith("snooze:")) return;

  // Snooze expired: restore blocking.
  const domain = alarm.name.slice("snooze:".length);
  const snoozed = await getSnoozed();
  delete snoozed[domain];
  await setSnoozed(snoozed); // (storage change re-schedules/clears the open alarm)
  await syncRules(); // restore the blocking rule
  await reblockOpenTabs(domain); // and bounce any open tabs to the blocked page
});


// --- Install / startup ---
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(["blockedDomains", "youtube", "allowedChannels"]);
  const seed = {};
  if (!stored.blockedDomains) seed.blockedDomains = DEFAULT_BLOCKED;
  if (!stored.youtube) seed.youtube = DEFAULT_YOUTUBE;
  if (!stored.allowedChannels) seed.allowedChannels = DEFAULT_CHANNELS;
  if (Object.keys(seed).length) await chrome.storage.sync.set(seed);
  await syncRules();
  await scheduleCountdown();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.blockedDomains) syncRules();
  // Snooze changes (re)schedule the auto-open alarms. NOTE: we deliberately do
  // NOT re-sync the blocking rules here — the popup owns rule add/remove for
  // snooze/unsnooze directly, and re-syncing would race with it (re-blocking a
  // site the popup just unblocked). Scheduling the alarms touches no rules.
  if (area === "local" && changes.snoozed) scheduleCountdown();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRules();
  await scheduleCountdown();
});
