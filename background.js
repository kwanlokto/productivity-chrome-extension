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
  WARNING_MS,
} from "./shared/core.js";
// The popup's rule for "+1 min", reused for the warning bar's button.
import { extendSnooze } from "./popup/storage.js";

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

// --- Toolbar badge and the last-minute warning ---
// While a site is unlocked, its tabs show the time left on the toolbar icon:
// whole minutes ("5m" … "1m") in amber, then seconds ("59s" … "1s") in red in
// the last minute (WARNING_MS). When the last minute starts, those tabs also get
// the warning bar (content/unlock-warning.js). Other tabs show nothing, and
// nothing shows while Focus Guard is off. In the last 30 seconds the popup
// opens once (see "Opening the popup" below).

const BADGE_ALARM = "badge-tick";

/** Alarms from earlier versions that may still be scheduled after an update. */
const RETIRED_ALARMS = ["open-30"];

const BADGE_COLORS = {
  normal: { background: "#f59e0b", text: "#111827" },
  warning: { background: "#dc2626", text: "#ffffff" },
};

/** Last badge set per tab ("text|warning"), so a tick only touches changes. */
const badgeStates = new Map();

/** Per tab, the unlock (unlockKey) its current page already has the bar for. */
const warnedTabs = new Map();

// Short waits (under the 30s minimum alarm delay) use a timer; the worker is
// still awake then because it just ran.
let badgeTimer = null;

/**
 * @param {number} remaining ms left on an unlock
 * @returns {string} e.g. "5m", or "42s" in the last minute
 */
function badgeText(remaining) {
  if (remaining > WARNING_MS) return Math.ceil(remaining / 60_000) + "m";
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
  if (remaining > WARNING_MS) {
    const minutes = Math.ceil(remaining / 60_000);
    return expiry - Math.max((minutes - 1) * 60_000, WARNING_MS);
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
 * Identifies one unlock: "+1 min" keeps it, a new unlock changes it.
 * @param {number | { start?: number, expiry: number }} entry
 */
function unlockKey(entry) {
  return typeof entry === "number" ? entry : entry.start ?? entry.expiry;
}

/**
 * @param {number} tabId
 * @param {string} text "" clears the badge
 * @param {boolean} [warning] the red last-minute colours
 */
function setTabBadge(tabId, text, warning = false) {
  const state = `${text}|${warning}`;
  if (badgeStates.get(tabId) === state) return;
  badgeStates.set(tabId, state);
  const colors = warning ? BADGE_COLORS.warning : BADGE_COLORS.normal;
  Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: colors.background }),
    chrome.action.setBadgeTextColor?.({ tabId, color: colors.text }),
  ]).catch(() => badgeStates.delete(tabId));
}

/** Active unlocks that should show a badge: none while Focus Guard is off. */
async function badgeSnoozes() {
  return (await isPaused()) ? {} : getSnoozed();
}

/**
 * Paint one tab's badge, and give it the warning bar once its unlock's last
 * minute starts.
 * @param {chrome.tabs.Tab} tab
 * @param {Record<string, unknown>} snoozed from badgeSnoozes
 * @param {number} now
 */
function paintTab(tab, snoozed, now) {
  const domain = unlockedDomainFor(tab.url, snoozed);
  if (!domain) {
    setTabBadge(tab.id, "");
    return;
  }
  const remaining = expiryOf(snoozed[domain]) - now;
  const warning = remaining <= WARNING_MS;
  setTabBadge(tab.id, badgeText(remaining), warning);
  // A page still loading gets the bar from onUpdated when it completes.
  if (warning && tab.status === "complete") showWarning(tab.id, snoozed[domain]);
}

/**
 * Put the warning bar into a tab, once per page and unlock, unless it was
 * dismissed for this unlock. The bar then follows the unlock by itself.
 * @param {number} tabId
 * @param {number | { start?: number, expiry: number }} entry
 */
async function showWarning(tabId, entry) {
  const key = unlockKey(entry);
  if (warnedTabs.get(tabId) === key) return;
  warnedTabs.set(tabId, key);
  const { dismissedWarnings = {} } = await chrome.storage.session.get("dismissedWarnings");
  if (dismissedWarnings[tabId] === key) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/unlock-warning.js"],
    });
  } catch {
    // A page extensions can't script (e.g. the Web Store), or the tab closed.
  }
}

/** Repaint every tab's badge and schedule the next change. */
async function updateBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = null;
  const [snoozed, tabs] = await Promise.all([badgeSnoozes(), chrome.tabs.query({})]);
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id != null) paintTab(tab, snoozed, now);
  }

  if (Object.values(snoozed).some((e) => expiryOf(e) - now <= POPUP_MS)) checkPopup();

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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") warnedTabs.delete(tabId); // a new page
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  badgeStates.delete(tabId); // Chrome may have reset the badge on navigation
  paintTab(tab, await badgeSnoozes(), Date.now());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  badgeStates.delete(tabId);
  warnedTabs.delete(tabId);
});

// --- Opening the popup ---
// When an unlock has POPUP_MS or less left, the popup opens by itself, once per
// unlock: only over the site's own tab, in the Chrome window in front, not in
// full screen, and not if the warning bar was hidden for this unlock. Closing
// it is final for that unlock, "+1 min" included (versions before 1.3.0
// reopened it every time it closed, which is what made it a nag). The checks
// run on every badge tick (each second in the last minute), so arriving on the
// site's tab, coming back to Chrome, or leaving full screen late still opens it.

const POPUP_MS = 30_000;

let popupChain = Promise.resolve();

/**
 * Open the popup if an unlock's last 30 seconds call for it. Serialized like
 * syncRules, so two triggers in a row can't both open it.
 */
function checkPopup() {
  popupChain = popupChain
    .then(doCheckPopup)
    .catch((e) => console.error("[Focus Guard] opening the popup failed:", e));
  return popupChain;
}

/** One check: see "Opening the popup" above for the conditions. */
async function doCheckPopup() {
  const snoozed = await badgeSnoozes();
  if (Object.keys(snoozed).length === 0) return;

  let win;
  try {
    win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
  } catch {
    return; // no browser window
  }
  const tab = win.tabs?.find((t) => t.active);
  const domain = unlockedDomainFor(tab?.url, snoozed);
  if (!domain) return;
  const remaining = expiryOf(snoozed[domain]) - Date.now();
  if (remaining > POPUP_MS || remaining <= 0) return;

  const key = unlockKey(snoozed[domain]);
  const { popupOpened = {}, dismissedWarnings = {} } = await chrome.storage.session.get([
    "popupOpened",
    "dismissedWarnings",
  ]);
  if (popupOpened[domain] === key) return;
  // ✕ on the warning bar, in any of the site's tabs, means "leave me alone".
  if (Object.values(dismissedWarnings).includes(key)) return;

  // Already open (the user opened it): that counts as its one time. Checked
  // before focus, because Chrome reports the window unfocused while it's open.
  const open = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
  if (open.length === 0) {
    // Another app in front, or full screen: wait.
    if (!win.focused || win.state === "fullscreen") return;
    try {
      await chrome.action.openPopup({ windowId: win.id });
    } catch {
      return; // Chrome refused (e.g. the window just lost focus): try next tick
    }
  }
  // Kept in session storage, so the worker sleeping can't make it open twice.
  // Entries for unlocks that have ended are dropped on the way.
  const kept = Object.entries(popupOpened).filter(([d]) => snoozed[d]);
  await chrome.storage.session.set({
    popupOpened: { ...Object.fromEntries(kept), [domain]: key },
  });
}

chrome.tabs.onActivated.addListener(() => checkPopup());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) checkPopup();
});

// --- Messages from the warning bar ---

/**
 * "+1 min" on the bar: extend the unlock of the site the tab is on, with the
 * popup's rule (never past the unlock's original length).
 * @param {chrome.tabs.Tab} tab
 */
async function extendUnlockFromTab(tab) {
  const domain = unlockedDomainFor(tab.url, await badgeSnoozes());
  if (!domain) return;
  const expiry = await extendSnooze(domain, 60_000);
  if (expiry != null) await chrome.alarms.create("snooze:" + domain, { when: expiry });
}

/**
 * ✕ on the bar: don't show it again in this tab for the rest of this unlock.
 * Kept in session storage so it survives the worker sleeping after "+1 min".
 * @param {chrome.tabs.Tab} tab
 */
async function dismissWarningInTab(tab) {
  const snoozed = await getSnoozed();
  const domain = unlockedDomainFor(tab.url, snoozed);
  if (!domain) return;
  const { dismissedWarnings = {} } = await chrome.storage.session.get("dismissedWarnings");
  dismissedWarnings[tab.id] = unlockKey(snoozed[domain]);
  await chrome.storage.session.set({ dismissedWarnings });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The domain always comes from the sending tab, never from the message.
  const tab = sender.tab;
  if (tab?.id == null) return;
  const handlers = {
    "fg-extend-unlock": extendUnlockFromTab,
    "fg-dismiss-warning": dismissWarningInTab,
  };
  const handler = handlers[message?.type];
  if (!handler) return;
  handler(tab).then(
    () => sendResponse(true),
    (e) => {
      console.error("[Focus Guard] warning bar action failed:", e);
      sendResponse(false);
    },
  );
  return true; // respond asynchronously
});

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
