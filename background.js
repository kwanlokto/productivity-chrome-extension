// Focus Guard — background service worker (ES module; see manifest "type").
// Keeps declarativeNetRequest dynamic rules in sync with the user's blocked-domain list.
// Also handles snooze: temporarily removes a domain's rule for X minutes, then restores it.

import {
  DEFAULT_BLOCKED,
  DEFAULT_YOUTUBE,
  DEFAULT_CHANNELS,
  normalizeDomain,
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

/** Is the whole extension currently paused? */
async function isPaused() {
  const { pausedUntil } = await chrome.storage.local.get("pausedUntil");
  return Boolean(pausedUntil && pausedUntil > Date.now());
}

/** Replace all dynamic rules with a fresh set built from current state. */
async function doSyncRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  // While paused, block nothing at all.
  if (await isPaused()) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    return;
  }
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const snoozed = await getSnoozed();
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

/** Reblock open tabs for every blocked (non-snoozed) domain — used after a pause. */
async function reblockAllOpenTabs() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const snoozed = await getSnoozed();
  for (const domain of blockedDomains) {
    if (!snoozed[domain]) await reblockOpenTabs(domain);
  }
}

/**
 * Send every tab currently sitting on our blocked page back to the real site it
 * came from — used when pausing, so already-blocked tabs unblock immediately
 * instead of waiting for the user to navigate. The original URL is everything
 * after "url=" (it may itself contain "?"/"&"), mirroring getBlockedOriginalUrl.
 */
async function releaseAllBlockedTabs() {
  const prefix = chrome.runtime.getURL("blocked.html");
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null || !tab.url || !tab.url.startsWith(prefix)) continue;
    const i = tab.url.indexOf("url=");
    if (i < 0) continue;
    const original = tab.url.slice(i + "url=".length);
    if (original) chrome.tabs.update(tab.id, { url: original });
  }
}

// --- Auto-open countdown ---
// In the final 30s before a snooze expires we open the popup (which shows the
// countdown circle) — but ONLY when the active tab is on the very site that's
// expiring. Nagging about facebook.com while you're reading YouTube makes no
// sense. Chrome can't pin a popup open, so we reopen it (while still on that site)
// whenever it closes or focus/tabs change.

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
    setTimeout(reopenIfRelevant, 200); // keep it up while on the expiring site
  });
});

// Reopen when the user returns to the expiring site (window focus / tab switch /
// in-tab navigation). reopenIfRelevant() gates on the active tab's domain.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  reopenIfRelevant();
});
chrome.tabs.onActivated.addListener(() => reopenIfRelevant());
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (tab.active && changeInfo.status === "complete") reopenIfRelevant();
});

/** Soonest expiry among active snoozes, or null if none. */
async function getNearestExpiry() {
  const snoozed = await getSnoozed();
  const expiries = Object.values(snoozed).map(expiryOf);
  return expiries.length ? Math.min(...expiries) : null;
}

/** The active tab's bare domain (or "" if none/unavailable). */
async function activeTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ? normalizeDomain(tab.url) : "";
  } catch {
    return "";
  }
}

/**
 * True when a snooze is in its final 30s AND the active tab is on that snoozed
 * domain — i.e. the moment it's actually worth nagging the user.
 */
async function shouldNag() {
  const snoozed = await getSnoozed();
  const now = Date.now();
  const imminent = Object.entries(snoozed)
    .filter(([, v]) => {
      const remaining = expiryOf(v) - now;
      return remaining > 0 && remaining <= OPEN_AT_30_MS;
    })
    .map(([domain]) => domain);
  if (imminent.length === 0) return false;

  const tabDomain = await activeTabDomain();
  if (!tabDomain) return false;
  return imminent.some((d) => tabDomain === d || tabDomain.endsWith("." + d));
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

/** Open the popup if it's closed and the active tab is the expiring site. */
async function reopenIfRelevant() {
  if (popupOpen) return;
  if (await shouldNag()) openPopupSafely();
}

/**
 * (Re)schedule the alarm that fires 30s before the nearest snooze expires. Alarms
 * persist across worker restarts. The handler still re-checks the active tab.
 */
async function scheduleCountdown() {
  await chrome.alarms.clear(OPEN30_ALARM);
  const expiry = await getNearestExpiry();
  if (!expiry) return;
  const when = expiry - OPEN_AT_30_MS;
  if (when > Date.now()) {
    await chrome.alarms.create(OPEN30_ALARM, { when });
  } else if (expiry > Date.now()) {
    reopenIfRelevant(); // already inside the window
  }
}

// --- Alarms ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === OPEN30_ALARM) {
    reopenIfRelevant(); // open only if we're on the expiring site
    return;
  }
  if (alarm.name === "fg-pause-end") {
    // Resume: clearing the pause triggers the storage listener below.
    await chrome.storage.local.remove("pausedUntil");
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

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes.blockedDomains) syncRules();
  // Snooze changes (re)schedule the auto-open alarms. NOTE: we deliberately do
  // NOT re-sync the blocking rules here — the popup owns rule add/remove for
  // snooze/unsnooze directly, and re-syncing would race with it (re-blocking a
  // site the popup just unblocked). Scheduling the alarms touches no rules.
  if (area === "local" && changes.snoozed) scheduleCountdown();

  // Pause/resume: rebuild rules (empty while paused, restored on resume). When
  // pausing, immediately release tabs stuck on the blocked page; when resuming,
  // bounce open tabs on blocked sites back to the blocked page.
  if (area === "local" && changes.pausedUntil) {
    await syncRules();
    const stillPaused =
      changes.pausedUntil.newValue && changes.pausedUntil.newValue > Date.now();
    if (stillPaused) await releaseAllBlockedTabs();
    else await reblockAllOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await syncRules();
  await scheduleCountdown();
});
