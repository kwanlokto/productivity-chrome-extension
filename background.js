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

/**
 * End the unlocks of domains that are no longer on the blocked list (removed in
 * the popup, dropped by an imported file, or removed on another synced device),
 * so their badge and re-block alarm don't outlive them.
 */
async function dropOrphanedSnoozes() {
  // Read the unlocks before the list: an unlock is only ever added for a domain
  // already on the list, so this order can't drop one that was just added.
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const orphans = Object.keys(snoozed).filter((d) => !blockedDomains.includes(d));
  if (orphans.length === 0) return;
  for (const domain of orphans) {
    delete snoozed[domain];
    await chrome.alarms.clear("snooze:" + domain);
  }
  await setSnoozed(snoozed);
}

// --- Toolbar badge ---
// While a site is unlocked, its tabs show the time left on the toolbar icon:
// whole minutes ("5m" … "1m"), then seconds ("59s" … "1s") in the last minute.
// Other tabs show nothing. The popup never opens by itself.

const BADGE_ALARM = "badge-tick";

/** Alarms from earlier versions that may still be scheduled after an update. */
const RETIRED_ALARMS = ["open-30"];

/** Last text set per tab, so a tick only touches badges that change. */
const badgeTexts = new Map();

// Short waits (under the 30s minimum alarm delay) use a timer; the worker is
// still awake then because it just ran.
let badgeTimer = null;

chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
chrome.action.setBadgeTextColor?.({ color: "#111827" });

/**
 * @param {number} remaining ms left on an unlock
 * @returns {string} e.g. "5m", or "42s" in the last minute
 */
function badgeText(remaining) {
  if (remaining > 59_000) return Math.ceil(remaining / 60_000) + "m";
  return Math.max(1, Math.ceil(remaining / 1000)) + "s";
}

/**
 * When an unlock's badge text next changes.
 * @param {number} expiry
 * @param {number} now
 * @returns {number} timestamp
 */
function nextBadgeChange(expiry, now) {
  const remaining = expiry - now;
  if (remaining > 59_000) {
    const minutes = Math.ceil(remaining / 60_000);
    return expiry - Math.max((minutes - 1) * 60_000, 59_000);
  }
  const seconds = Math.ceil(remaining / 1000);
  return expiry - (seconds - 1) * 1000;
}

/**
 * The unlocked domain a tab is on, if any.
 * @param {string | undefined} url
 * @param {Record<string, unknown>} snoozed active snooze map
 * @returns {string | null}
 */
function unlockedDomainFor(url, snoozed) {
  if (!url || !/^https?:/i.test(url)) return null;
  const host = normalizeDomain(url);
  return Object.keys(snoozed).find((d) => host === d || host.endsWith("." + d)) || null;
}

/**
 * @param {number} tabId
 * @param {string} text "" clears the badge
 */
function setTabBadge(tabId, text) {
  if (badgeTexts.get(tabId) === text) return;
  badgeTexts.set(tabId, text);
  chrome.action.setBadgeText({ tabId, text }).catch(() => badgeTexts.delete(tabId));
}

/** Active unlocks that should show a badge: none while Focus Guard is off. */
async function badgeSnoozes() {
  return (await isPaused()) ? {} : getSnoozed();
}

/** Repaint every tab's badge and schedule the next change. */
async function updateBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = null;
  const [snoozed, tabs] = await Promise.all([badgeSnoozes(), chrome.tabs.query({})]);
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const domain = unlockedDomainFor(tab.url, snoozed);
    setTabBadge(tab.id, domain ? badgeText(expiryOf(snoozed[domain]) - now) : "");
  }

  const expiries = Object.values(snoozed).map(expiryOf);
  if (expiries.length === 0) {
    await chrome.alarms.clear(BADGE_ALARM);
    return;
  }
  // +50ms so the tick lands just after the boundary, not just before it.
  const next = Math.min(...expiries.map((e) => nextBadgeChange(e, now))) + 50;
  if (next - now < 30_000) {
    badgeTimer = setTimeout(updateBadges, next - now);
  } else {
    await chrome.alarms.create(BADGE_ALARM, { when: next });
  }
}

/**
 * Repaint one tab's badge, e.g. after it navigates.
 * @param {number} tabId
 * @param {string | undefined} url
 */
async function updateTabBadge(tabId, url) {
  const snoozed = await badgeSnoozes();
  const domain = unlockedDomainFor(url, snoozed);
  setTabBadge(tabId, domain ? badgeText(expiryOf(snoozed[domain]) - Date.now()) : "");
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  badgeTexts.delete(tabId); // Chrome may have reset it on navigation
  updateTabBadge(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => badgeTexts.delete(tabId));

// --- Alarms ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) {
    updateBadges();
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
  await setSnoozed(snoozed);
  await syncRules(); // restore the blocking rule
  // Bounce open tabs to the blocked page, unless nothing is blocking them now.
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  if (blockedDomains.includes(domain) && !(await isPaused())) {
    await reblockOpenTabs(domain);
  }
});

/** Clear alarms that earlier versions scheduled and this one no longer handles. */
async function clearRetiredAlarms() {
  for (const name of RETIRED_ALARMS) await chrome.alarms.clear(name);
}

// --- Install / startup ---
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(["blockedDomains", "youtube", "allowedChannels"]);
  const seed = {};
  if (!stored.blockedDomains) seed.blockedDomains = DEFAULT_BLOCKED;
  if (!stored.youtube) seed.youtube = DEFAULT_YOUTUBE;
  if (!stored.allowedChannels) seed.allowedChannels = DEFAULT_CHANNELS;
  if (Object.keys(seed).length) await chrome.storage.sync.set(seed);
  await clearRetiredAlarms();
  await dropOrphanedSnoozes();
  await syncRules();
  await updateBadges();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes.blockedDomains) {
    syncRules();
    dropOrphanedSnoozes();
  }
  // Snooze changes only repaint the badges. NOTE: we deliberately do NOT re-sync
  // the blocking rules here — the popup owns rule add/remove for snooze/unsnooze
  // directly, and re-syncing would race with it (re-blocking a site the popup
  // just unblocked).
  if (area === "local" && changes.snoozed) updateBadges();

  // Pause/resume: rebuild rules (empty while paused, restored on resume). When
  // pausing, immediately release tabs stuck on the blocked page; when resuming,
  // bounce open tabs on blocked sites back to the blocked page.
  if (area === "local" && changes.pausedUntil) {
    updateBadges();
    await syncRules();
    const stillPaused =
      changes.pausedUntil.newValue && changes.pausedUntil.newValue > Date.now();
    if (stillPaused) await releaseAllBlockedTabs();
    else await reblockAllOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearRetiredAlarms();
  await syncRules();
  await updateBadges();
});
