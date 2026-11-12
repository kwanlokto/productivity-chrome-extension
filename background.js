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
// opens, or a notification shows (see "The last 30 seconds" below).

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

  checkEnding();

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

// --- The last 30 seconds: the popup, or a notification ---
// When an unlock has ENDING_MS or less left, Focus Guard warns once more:
// - On the site's own tab, in the Chrome window in front, the popup opens.
// - If the site is showing but the popup can't open over it (Chrome is
//   minimized, behind another app, or full screen), a desktop notification
//   says when it blocks again, with "+1 min". Clicking it brings Chrome back
//   on that tab, out of full screen, where the popup then opens.
// Each happens at most once per unlock, "+1 min" included, and once the popup
// has opened no notification follows. Neither happens while you're in Chrome
// on another tab, while Focus Guard is off, or after the warning bar was
// hidden for this unlock. A notification clears itself as soon as it no
// longer applies: the unlock ends or gets more time, you're back in Chrome,
// or Focus Guard is switched off. (Versions before 1.3.0 reopened the popup
// every time it closed, which made it a nag. Don't bring that back.)
//
// The check runs on every badge tick (each second in the last minute), and
// when you switch tabs or Chrome windows.

const ENDING_MS = 30_000;

/** Notification ids are this plus the domain. */
const ENDING_NOTE = "ending:";

/** Every window type, so focus in any Chrome window counts as Chrome in front. */
const ALL_WINDOW_TYPES = ["normal", "popup", "panel", "app", "devtools"];

let endingChain = Promise.resolve();

/** Check the last 30 seconds, serialized so two checks can't both act. */
function checkEnding() {
  endingChain = endingChain
    .then(doCheckEnding)
    .catch((e) => console.error("[Focus Guard] last-30-seconds check failed:", e));
  return endingChain;
}

/**
 * Where you are in Chrome right now.
 * @returns {Promise<{ windows: chrome.windows.Window[], front: chrome.windows.Window | null, inFront: boolean, popupOpen: boolean }>}
 *   `front` is the window you're looking at, null while Chrome isn't in front.
 */
async function chromeView() {
  const [windows, popups] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ALL_WINDOW_TYPES }),
    chrome.runtime.getContexts({ contextTypes: ["POPUP"] }),
  ]);
  const popupOpen = popups.length > 0;
  let front = windows.find((w) => w.focused) ?? null;
  // While the popup is open, Chrome reports every window unfocused (and the
  // popup's context has no window id): it's over the last focused window.
  if (!front && popupOpen) {
    const last = await chrome.windows.getLastFocused().catch(() => null);
    front = windows.find((w) => w.id === last?.id) ?? null;
  }
  return { windows, front, inFront: popupOpen || front != null, popupOpen };
}

/**
 * The unlocked site a window is showing (its active tab), if any.
 * @param {chrome.windows.Window | null} win
 * @param {Record<string, unknown>} snoozed
 */
function siteShownIn(win, snoozed) {
  if (win?.type !== "normal") return null;
  return unlockedDomainFor(win.tabs?.find((t) => t.active)?.url, snoozed);
}

/**
 * The "blocks again in 30 seconds" notification.
 * @param {string} domain
 * @param {number} left ms until the site blocks again
 * @param {boolean} fullScreen the site is in front, in full screen
 * @returns {chrome.notifications.NotificationOptions}
 */
function endingNotification(domain, left, fullScreen) {
  const seconds = Math.max(1, Math.ceil(left / 1000));
  return {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${domain} blocks again in ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
    message: fullScreen ? "Click to leave full screen." : "Click to go back to it.",
    buttons: [{ title: "+1 min" }],
    // Urgent only in full screen: GNOME, for one, shows nothing else over a
    // full-screen window. Elsewhere a normal one, so Do Not Disturb holds.
    priority: fullScreen ? 2 : 0,
  };
}

/** One check: see "The last 30 seconds" above for the rules. */
async function doCheckEnding() {
  const snoozed = await badgeSnoozes();
  const [session, notifications] = await Promise.all([
    chrome.storage.session.get(["popupOpened", "notificationShown", "dismissedWarnings"]),
    chrome.notifications.getAll(),
  ]);
  const { popupOpened = {}, notificationShown = {}, dismissedWarnings = {} } = session;
  const hidden = Object.values(dismissedWarnings);
  const now = Date.now();
  const ending = Object.keys(snoozed).filter((d) => {
    const left = expiryOf(snoozed[d]) - now;
    return left > 0 && left <= ENDING_MS && !hidden.includes(unlockKey(snoozed[d]));
  });
  const shown = Object.keys(notifications)
    .filter((id) => id.startsWith(ENDING_NOTE))
    .map((id) => id.slice(ENDING_NOTE.length));
  if (ending.length === 0 && shown.length === 0) return;

  const { windows, front, inFront, popupOpen } = await chromeView();
  const wanted = new Set(); // sites whose notification still applies
  let recorded = false;

  for (const domain of ending) {
    const key = unlockKey(snoozed[domain]);
    const onSite = siteShownIn(front, snoozed) === domain;

    if (onSite && (popupOpen || front.state !== "fullscreen")) {
      // On the site, the popup's turn. Already open counts as its one time.
      if (popupOpened[domain] === key) continue;
      if (!popupOpen) {
        try {
          await chrome.action.openPopup({ windowId: front.id });
        } catch {
          continue; // Chrome refused (e.g. focus just moved): try next tick
        }
      }
      popupOpened[domain] = key;
      recorded = true;
      continue;
    }

    // The popup can't open over the site: it's in full screen, or Chrome
    // isn't in front while the site is showing in one of its windows.
    const showing = onSite || (!inFront && windows.some((w) => siteShownIn(w, snoozed) === domain));
    if (!showing) continue;
    wanted.add(domain);
    if (popupOpened[domain] === key || notificationShown[domain] === key) continue;
    const left = expiryOf(snoozed[domain]) - Date.now();
    try {
      await chrome.notifications.create(ENDING_NOTE + domain, endingNotification(domain, left, onSite));
    } catch (e) {
      console.error("[Focus Guard] couldn't show the notification:", e);
    }
    notificationShown[domain] = key; // even on failure: no retry every second
    recorded = true;
  }

  await Promise.all(
    shown.filter((d) => !wanted.has(d)).map((d) => chrome.notifications.clear(ENDING_NOTE + d)),
  );

  if (recorded) {
    // Session storage, so the worker sleeping can't make either happen twice.
    // Records of unlocks that have ended are dropped on the way. (Not checked
    // against `snoozed`, which is empty while Focus Guard is off.)
    const live = await getSnoozed();
    const keep = (map) => Object.fromEntries(Object.entries(map).filter(([d]) => live[d]));
    await chrome.storage.session.set({
      popupOpened: keep(popupOpened),
      notificationShown: keep(notificationShown),
    });
  }
}

/**
 * Clicking the notification: bring Chrome back on the site's tab, restoring a
 * minimized window and leaving full screen. The focus change then opens the
 * popup.
 * @param {string} domain
 */
async function goToSite(domain) {
  const snoozed = await badgeSnoozes();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const tabs = windows
    .flatMap((w) => w.tabs ?? [])
    .filter((t) => unlockedDomainFor(t.url, snoozed) === domain);
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (tab?.id == null) return;
  await chrome.tabs.update(tab.id, { active: true });
  const win = windows.find((w) => w.id === tab.windowId);
  // Focusing brings back a minimized window as it was (maximized or not),
  // which "normal" wouldn't; full screen has to be left with "normal".
  await chrome.windows.update(
    tab.windowId,
    win?.state === "fullscreen" ? { state: "normal", focused: true } : { focused: true },
  );
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith(ENDING_NOTE)) return;
  await chrome.notifications.clear(id);
  await goToSite(id.slice(ENDING_NOTE.length));
});

chrome.notifications.onButtonClicked.addListener(async (id) => {
  if (!id.startsWith(ENDING_NOTE)) return;
  const domain = id.slice(ENDING_NOTE.length);
  await chrome.notifications.clear(id);
  if ((await badgeSnoozes())[domain]) await extendUnlock(domain); // "+1 min"
});

chrome.tabs.onActivated.addListener(() => checkEnding());
chrome.windows.onFocusChanged.addListener((windowId) => {
  // Leaving Chrome is picked up by the next tick, within a second: on some
  // Linux window managers WINDOW_ID_NONE also comes between two Chrome windows.
  if (windowId !== chrome.windows.WINDOW_ID_NONE) checkEnding();
});

// --- Messages from the warning bar ---

/**
 * "+1 min", on the bar or the notification: extend a site's unlock with the
 * popup's rule (never past the unlock's original length).
 * @param {string} domain
 */
async function extendUnlock(domain) {
  const expiry = await extendSnooze(domain, 60_000);
  if (expiry != null) await chrome.alarms.create("snooze:" + domain, { when: expiry });
}

/**
 * "+1 min" on the bar: extend the unlock of the site the tab is on.
 * @param {chrome.tabs.Tab} tab
 */
async function extendUnlockFromTab(tab) {
  const domain = unlockedDomainFor(tab.url, await badgeSnoozes());
  if (domain) await extendUnlock(domain);
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
