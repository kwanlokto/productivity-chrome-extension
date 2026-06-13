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

// --- Toolbar countdown ---
// In the last 30s of a snooze, show the seconds left on the toolbar icon's badge.
// The final 10s go "dramatic": a red alert icon and a fast red/dark flashing badge.

const NORMAL_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const ALERT_ICON = { 16: "icons/alert16.png", 48: "icons/alert48.png", 128: "icons/alert128.png" };

const COUNTDOWN_WINDOW_MS = 30_000; // when the badge starts showing
const DRAMATIC_MS = 10_000; // when the flashing begins
const COUNTDOWN_ALARM = "countdown";

let countdownInterval = null;
let flashOn = false;

/** Soonest expiry among active snoozes, or null if none. */
async function getNearestExpiry() {
  const snoozed = await getSnoozed();
  const expiries = Object.values(snoozed).map(expiryOf);
  return expiries.length ? Math.min(...expiries) : null;
}

/** Clear the badge and restore the normal icon. */
function clearBadge() {
  flashOn = false;
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setIcon({ path: NORMAL_ICON });
}

/** Paint one frame of the countdown for `remaining` ms left. */
function paintFrame(remaining) {
  const secs = Math.ceil(remaining / 1000);
  chrome.action.setBadgeText({ text: String(secs) });

  if (remaining <= DRAMATIC_MS) {
    // Final 10s: red alert icon + flashing red badge.
    flashOn = !flashOn;
    chrome.action.setIcon({ path: ALERT_ICON });
    chrome.action.setBadgeBackgroundColor({ color: flashOn ? "#ef4444" : "#7f1d1d" });
    chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  } else {
    // 30s–11s: steady amber.
    chrome.action.setIcon({ path: NORMAL_ICON });
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    chrome.action.setBadgeTextColor?.({ color: "#1f2937" });
  }
}

function stopTicker() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/**
 * One tick of the countdown: figure out the nearest snooze and either paint the
 * badge, clear it (not in the window / unsnoozed), or stop (expired).
 */
async function tickCountdown() {
  const expiry = await getNearestExpiry();
  const remaining = expiry ? expiry - Date.now() : -1;

  if (remaining <= 0) {
    clearBadge();
    stopTicker();
    return;
  }
  if (remaining > COUNTDOWN_WINDOW_MS) {
    clearBadge(); // alarm woke us a touch early; wait for the window
    return;
  }
  paintFrame(remaining);
}

/** Start the per-frame ticker (idempotent). Ticking ~3×/s keeps the SW alive. */
function startTicker() {
  if (countdownInterval) return;
  countdownInterval = setInterval(tickCountdown, 300);
  tickCountdown();
}

/**
 * Schedule (or clear) the alarm that wakes the worker 30s before the nearest
 * snooze expires. If we're already inside the window, start ticking immediately.
 */
async function scheduleCountdown() {
  const expiry = await getNearestExpiry();
  if (!expiry) {
    await chrome.alarms.clear(COUNTDOWN_ALARM);
    clearBadge();
    stopTicker();
    return;
  }
  const when = expiry - COUNTDOWN_WINDOW_MS;
  if (when <= Date.now()) {
    startTicker();
  } else {
    await chrome.alarms.create(COUNTDOWN_ALARM, { when });
  }
}

// --- Alarms ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === COUNTDOWN_ALARM) {
    startTicker(); // begin painting the badge for the final 30s
    return;
  }
  if (!alarm.name.startsWith("snooze:")) return;

  // Snooze expired: restore blocking.
  const domain = alarm.name.slice("snooze:".length);
  const snoozed = await getSnoozed();
  delete snoozed[domain];
  await setSnoozed(snoozed); // (storage change re-schedules/clears the countdown)
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
  // Snooze changes drive the toolbar countdown. NOTE: we deliberately do NOT
  // re-sync the blocking rules here — the popup owns rule add/remove for
  // snooze/unsnooze directly, and re-syncing would race with it (re-blocking a
  // site the popup just unblocked). Scheduling the countdown touches no rules.
  if (area === "local" && changes.snoozed) scheduleCountdown();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRules();
  await scheduleCountdown();
});
